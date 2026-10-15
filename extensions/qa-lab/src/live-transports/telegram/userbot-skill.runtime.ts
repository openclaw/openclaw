import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

type TelegramUserCredential = {
  testerUserId: string;
  tdlibArchiveBase64: string;
  tdlibArchiveSha256: string;
  tdlibVersion: string;
};

export type TelegramTestCredential = TelegramUserCredential & {
  environment: "test";
  groupId: string;
  schemaVersion: 1;
  sutBotId: string;
  sutToken: string;
  sutUsername: string;
  forumGroupId?: string;
  forumTopicId?: number;
  participants?: Array<TelegramUserCredential & { alias: string }>;
};

type RestoredTelegramTestCredential = TelegramTestCredential & {
  driverEnv: Record<string, string>;
  stateRoot: string;
  userDriverDir: string;
};

type TelegramTestApiProxy = {
  apiRoot: string;
  close(): Promise<void>;
  drainUpdates(token: string): Promise<void>;
};

type TelegramUserbotSkillRuntime = {
  createStateRoot(): string;
  parseCredential(value: unknown): TelegramTestCredential;
  restoreCredential(this: void, value: unknown, stateRoot: string): RestoredTelegramTestCredential;
  startApiProxy(leaseHealth: {
    assertHealthy(): void;
    whenUnhealthy: Promise<Error>;
  }): Promise<TelegramTestApiProxy>;
  userDriverPath: string;
};

export async function loadTelegramUserbotSkillRuntime(params?: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}): Promise<TelegramUserbotSkillRuntime> {
  const env = params?.env ?? process.env;
  const repoRoot = params?.repoRoot ?? process.cwd();
  const skillDir = path.resolve(
    env.TELEGRAM_E2E_SKILL_DIR?.trim() ||
      path.join(repoRoot, ".agents", "skills", "telegram-e2e-userbot"),
  );
  const credentialPath = path.join(skillDir, "scripts", "telegram-test-credential.mjs");
  const proxyPath = path.join(skillDir, "scripts", "telegram-test-api-proxy.mjs");
  const userDriverPath = path.join(skillDir, "scripts", "user-driver.py");
  for (const requiredPath of [credentialPath, proxyPath, userDriverPath]) {
    if (!fs.statSync(requiredPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(
        `Telegram userbot skill is missing ${path.relative(skillDir, requiredPath)}.`,
      );
    }
  }
  // The selected skill owns credential validation and restoration. Its trusted
  // module results are internal facts, not another credential-input boundary.
  const [credentialModule, proxyModule]: [
    {
      parseTelegramTestCredential: TelegramUserbotSkillRuntime["parseCredential"];
      restoreTelegramTestCredential: TelegramUserbotSkillRuntime["restoreCredential"];
    },
    {
      startTelegramTestApiProxy(params: {
        leaseHealth: Parameters<TelegramUserbotSkillRuntime["startApiProxy"]>[0];
      }): Promise<TelegramTestApiProxy>;
    },
  ] = await Promise.all([
    import(pathToFileURL(credentialPath).href),
    import(pathToFileURL(proxyPath).href),
  ]);
  const parseCredential = credentialModule.parseTelegramTestCredential;
  const restoreCredential = credentialModule.restoreTelegramTestCredential;
  const startApiProxy = proxyModule.startTelegramTestApiProxy;
  if (
    typeof parseCredential !== "function" ||
    typeof restoreCredential !== "function" ||
    typeof startApiProxy !== "function"
  ) {
    throw new Error("Telegram userbot skill does not expose its runtime helpers.");
  }
  return {
    userDriverPath,
    createStateRoot: () =>
      fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-qa-telegram-")),
    parseCredential,
    restoreCredential,
    startApiProxy: (leaseHealth) => startApiProxy({ leaseHealth }),
  };
}
