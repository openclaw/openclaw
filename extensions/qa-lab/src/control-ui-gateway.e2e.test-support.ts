import { writeFile } from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserContextOptions, Page } from "playwright";
import { createQaLiveLaneGateway } from "./live-transports/shared/live-gateway.runtime.ts";

type GatewayOwner = ReturnType<typeof createQaLiveLaneGateway>;
type GatewayOverrides = Pick<Parameters<GatewayOwner["start"]>[0], "command" | "mutateConfig">;
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

export function startControlUiGateway(
  owner: GatewayOwner,
  baseUrl: string,
  overrides: GatewayOverrides = {},
) {
  return owner.start({
    repoRoot: process.cwd(),
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna-alt",
    transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
    transportBaseUrl: "http://127.0.0.1",
    controlUiAllowedOrigins: [new URL(baseUrl).origin],
    controlUiEnabled: false,
    ...overrides,
  });
}

export function controlUiPageOptions(proofDir: string): BrowserContextOptions {
  const viewport = { width: 1280, height: 900 };
  return {
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(captureUiProof ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
  };
}

export async function authenticateControlUi(page: Page, gateway: { wsUrl: string; token: string }) {
  await page.addInitScript(
    ({ gatewayUrl, token }) => {
      (
        window as Window & {
          __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
    },
    { gatewayUrl: gateway.wsUrl, token: gateway.token },
  );
}

export async function captureControlUi(page: Page, proofDir: string, name: string) {
  if (captureUiProof) {
    await page.screenshot({ path: path.join(proofDir, name) });
  }
}

export function writeControlUiVerdict(proofDir: string, verdict: unknown) {
  return writeFile(path.join(proofDir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
}

export function historyMessages(history: unknown): unknown[] {
  const messages = asOptionalRecord(history)?.messages;
  return Array.isArray(messages) ? messages : [];
}

export async function stopControlUiGateway(
  owner: GatewayOwner,
  proofDir: string,
  message: string,
  errors: unknown[] = [],
) {
  const stopped = await owner.stop({ preserveToDir: path.join(proofDir, "gateway") });
  errors.push(...stopped.errors);
  if (errors.length > 0) {
    throw new AggregateError(errors, message);
  }
}
