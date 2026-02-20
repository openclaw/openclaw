import { writeFileSync } from "node:fs";
import { extractErrorMessage } from "./error-utils.js";
import { PairingQrCodeStorage } from "./pairing-storage.js";
import { rpcServerManager } from "./rpc-server.js";
import { DEFAULT_DATA_DIR, type CoreConfig } from "./types.js";
import { ensureDataDir, copyAvatarToDataDir } from "./utils.js";

export interface PairingQrCodeResult {
  ok: boolean;
  qrCodeData?: string;
  filePath?: string;
  error?: string;
}

export interface GeneratePairingQrCodeOpts {
  cfg?: CoreConfig;
  accountId?: string;
  output?: "terminal" | string;
  format?: "text" | "image";
}

/**
 * Generate a QR code for pairing a Delta.Chat client.
 * This creates a new account or uses an existing one and generates
 * the QR code that can be scanned by the Delta.Chat mobile app or desktop client.
 */
export async function generatePairingQrCode(
  opts: GeneratePairingQrCodeOpts = {},
): Promise<PairingQrCodeResult> {
  const { cfg, accountId: _accountId = "default", output = "terminal" } = opts;

  try {
    // Use existing RPC server if running, otherwise start a new one
    const dataDir = ensureDataDir(cfg?.channels?.deltachat?.dataDir ?? DEFAULT_DATA_DIR);

    // First, check if a QR code is already stored (from gateway startup)
    console.log(`[deltachat] Checking for stored QR code in ${dataDir}...`);
    const storedQrCode = PairingQrCodeStorage.retrieveQrCode(dataDir);
    if (storedQrCode) {
      console.log(`[deltachat] Found stored QR code, returning it directly`);
      // QR code is already stored, return it directly
      let filePath: string | undefined;
      if (output !== "terminal") {
        const outputPath =
          output.endsWith(".txt") || output.endsWith(".qr") ? output : `${output}.qr`;
        console.log(`[deltachat] Writing QR code to file: ${outputPath}`);
        writeFileSync(outputPath, storedQrCode, "utf8");
        filePath = outputPath;
      }

      return {
        ok: true,
        qrCodeData: storedQrCode,
        filePath,
      };
    } else {
      console.log(`[deltachat] No stored QR code found, generating new one...`);
    }

    // No stored QR code found, try to start RPC server and generate one
    console.log(`[deltachat] No stored QR code found, starting RPC server...`);
    let dc = rpcServerManager.get(dataDir);

    if (!dc) {
      console.log(`[deltachat] Starting new RPC server for dataDir: ${dataDir}`);
      dc = await rpcServerManager.start(dataDir);
    }

    if (!dc) {
      console.log(`[deltachat] Failed to start RPC server`);
      return {
        ok: false,
        error: `Delta.Chat RPC server could not be started. This usually means another process (like the gateway) is using the data directory: ${dataDir}

To generate a pairing code:
1. Stop the gateway: openclaw gateway stop
2. Run pairing: openclaw pairing generate --channel deltachat
3. Restart the gateway: openclaw gateway start

Or configure Delta.Chat first by editing ~/.openclaw/openclaw.json or running openclaw onboard`,
      };
    }

    // Get or create account
    console.log(`[deltachat] Getting accounts from RPC server...`);
    let accounts = await dc.rpc.getAllAccounts();
    let account = accounts[0];

    if (!account) {
      console.log(`[deltachat] No account found, creating new account...`);
      const newAccountId = await dc.rpc.addAccount();
      account = await dc.rpc.getAccountInfo(newAccountId);
      console.log(`[deltachat] Created new account: ${account.id}`);
    } else {
      console.log(`[deltachat] Using existing account: ${account.id}`);
    }

    // Configure the account if needed
    console.log(`[deltachat] Account kind: ${account.kind}`);
    if (account.kind === "Unconfigured") {
      console.log(`[deltachat] Account is unconfigured, attempting to configure...`);
      // For pairing, we need to configure the account first
      // Use config file values as primary source, fall back to environment variables
      const dcConfig = cfg?.channels?.deltachat ?? {};
      const addr = dcConfig.addr ?? process.env.DELTACHAT_ADDR;
      const mailPw = dcConfig.mail_pw ?? process.env.DELTACHAT_MAIL_PW;
      const chatmailQr = dcConfig.chatmailQr ?? process.env.DELTACHAT_CHATMAIL_QR;

      if (chatmailQr) {
        console.log(`[deltachat] Configuring with chatmail QR code...`);
        const avatarPath = copyAvatarToDataDir(dataDir);
        const config: Record<string, string> = {
          bot: "1",
          e2ee_enabled: "1",
          displayname: "OpenClaw",
          selfavatar: avatarPath ?? "",
        };
        await dc.rpc.batchSetConfig(account.id, config);
        await dc.rpc.setConfigFromQr(account.id, chatmailQr);
        // After setting the QR code, Delta.Chat creates a random email address
        // We need to configure the account to finalize the setup
        console.log(`[deltachat] Calling configure() after setConfigFromQr...`);
        await dc.rpc.configure(account.id);
        console.log(`[deltachat] Account configured with chatmail QR`);
      } else if (addr && mailPw) {
        console.log(`[deltachat] Configuring with email credentials...`);
        const avatarPath = copyAvatarToDataDir(dataDir);
        const config: Record<string, string> = {
          addr,
          mail_pw: mailPw,
          bot: "1",
          e2ee_enabled: "1",
          displayname: "OpenClaw",
          selfavatar: avatarPath ?? "",
        };
        await dc.rpc.batchSetConfig(account.id, config);
        console.log(`[deltachat] Calling configure()...`);
        await dc.rpc.configure(account.id);
        console.log(`[deltachat] Account configured with email credentials`);
      } else {
        // For pairing, we need a configured account
        // Create a temporary account with a random email for QR generation
        // This is a workaround - in production, you'd configure the account first
        console.log(`[deltachat] No configuration found, cannot proceed`);
        return {
          ok: false,
          error:
            "Account not configured. Please configure Delta.Chat first by editing ~/.openclaw/openclaw.json or running openclaw onboard, or set DELTACHAT_ADDR/DELTACHAT_MAIL_PW environment variables.",
        };
      }
    } else {
      console.log(`[deltachat] Account is already configured`);
    }

    // Start IO to ensure the account is ready
    console.log(`[deltachat] Starting IO for account ${account.id}...`);
    await dc.rpc.startIo(account.id);

    // Generate the QR code for pairing using the securejoin protocol
    // Use chatId: null to generate the "Contact Me" QR code (setup contact QR code)
    // This returns a URL that can be scanned by Delta.Chat clients
    console.log(`[deltachat] Generating QR code for account ${account.id} with chatId: null...`);
    const qrCodeData = await dc.rpc.getChatSecurejoinQrCode(account.id, null);

    if (!qrCodeData) {
      console.log(`[deltachat] QR code generation failed - no data returned`);
      return {
        ok: false,
        error: "Failed to generate QR code. The account may not be properly configured.",
      };
    }

    console.log(`[deltachat] QR code generated successfully: ${qrCodeData}`);

    // Store the QR code for future retrieval
    // This allows the pairing command to retrieve the QR code without starting its own RPC server
    PairingQrCodeStorage.storeQrCode(dataDir, qrCodeData);

    // Save to file if requested
    let filePath: string | undefined;
    if (output !== "terminal") {
      const outputPath =
        output.endsWith(".txt") || output.endsWith(".qr") ? output : `${output}.qr`;
      writeFileSync(outputPath, qrCodeData, "utf8");
      filePath = outputPath;
    }

    // Stop the RPC server to prevent hanging
    // Only stop if we started it (not if it was already running)
    if (dc && rpcServerManager.isRunning()) {
      await rpcServerManager.stop();
    }

    return {
      ok: true,
      qrCodeData,
      filePath,
    };
  } catch (err) {
    // Ensure RPC server is stopped even on error
    if (rpcServerManager.isRunning()) {
      await rpcServerManager.stop();
    }
    return {
      ok: false,
      error: extractErrorMessage(err),
    };
  }
}
