import { setTimeout as sleep } from "node:timers/promises";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { z } from "zod";
import type { CommandLike } from "./cli.js";

const publicReply = z.object({
  state: z.string(),
  code: z.string().optional(),
  sessionId: z.string().optional(),
  connectUrl: z.string().optional(),
  confirmationCode: z.string().optional(),
  expiresAt: z.string().optional(),
});

/** Forward every operation to the live Gateway so refresh and pickup have one writer. */
export function registerAutofillCommands(command: CommandLike): void {
  const invoke = async (action: string, params?: Record<string, unknown>) => {
    const result = publicReply.safeParse(
      await callGatewayFromCli(
        `onepassword.autofill.${action}`,
        { timeout: "40000" },
        params ?? {},
      ),
    );
    if (!result.success) {
      throw new Error(
        "1Password Gateway returned an invalid response; check Agentic Autofill setup.",
      );
    }
    if (result.data.state === "error") {
      throw new Error(`1Password Agentic Autofill: ${result.data.code ?? "operationFailed"}.`);
    }
    return result.data;
  };
  command
    .command("connect")
    .description("Connect your own 1Password for Agentic Autofill")
    .action(async () => {
      const session = await invoke("connect");
      if (
        !session.connectUrl ||
        !session.confirmationCode ||
        !session.sessionId ||
        !session.expiresAt
      ) {
        throw new Error("1Password connect session is incomplete.");
      }
      process.stdout.write(
        `Open ${session.connectUrl}\nConfirmation code: ${session.confirmationCode}\nContinue only if the codes match. Waiting for consent...\n`,
      );
      while (Date.now() < Date.parse(session.expiresAt)) {
        await sleep(2000);
        const result = await invoke("pickup", { sessionId: session.sessionId });
        if (result.state !== "pending") {
          process.stdout.write(`1Password: ${result.state}.\n`);
          return;
        }
      }
      throw new Error("1Password connect link expired. Run openclaw onepassword connect again.");
    });
  command
    .command("disconnect")
    .description("Revoke your entire 1Password Agentic Autofill connection")
    .action(async () => {
      process.stdout.write(`1Password: ${(await invoke("disconnect")).state}.\n`);
    });
  command
    .command("autofill-status")
    .description("Show Agentic Autofill readiness without secrets")
    .action(async () => {
      const result = await invoke("status");
      process.stdout.write(`1Password Agentic Autofill: ${result.state}.\n`);
    });
}
