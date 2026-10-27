import { Command } from "commander";
import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { registerGoogleMeetCli } from "../cli.js";
import { resolveGoogleMeetConfig } from "../config.js";
import type { GoogleMeetRuntime } from "../runtime.js";
import { captureStdout, meetApiFixtures } from "./fixtures.test-helpers.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: vi.fn(async (params: { url: string; init?: RequestInit }) => ({
    response: await fetch(params.url, params.init),
    release: vi.fn(async () => {}),
  })),
}));

export function useCli() {
  let stdout: ReturnType<typeof captureStdout>;
  beforeEach(() => (stdout = captureStdout()));
  afterEach(() => {
    vi.restoreAllMocks();
    stdout.restore();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  });
  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });
  return {
    run: async (args: string[], params: Parameters<typeof setupCli>[0] = {}) => {
      stdout.restore();
      stdout = captureStdout();
      await setupCli(params).parseAsync(["googlemeet", ...args], { from: "user" });
    },
    output: () => stdout.output(),
    json: (): Record<string, unknown> => JSON.parse(stdout.output()),
  };
}

export const jsonResponse = (value: unknown): Response => Response.json(value);

function stubFetch(respond: (url: URL) => Response | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    return respond(url) ?? new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export const expectText = (text: string, ...parts: string[]) =>
  parts.forEach((part) => expect(text).toContain(part));

export const stubJsonRoutes = (routes: Record<string, unknown>) =>
  stubFetch(({ href }) => (routes[href] ? jsonResponse(routes[href]) : undefined));

export function stubMeetArtifactsApi(
  options: { failSmartNoteDocumentBody?: boolean; participantDisplayName?: string } = {},
) {
  const fixtures: Record<string, unknown> = meetApiFixtures(options);
  const documents: Record<string, string> = {
    "/drive/v3/files/doc-1/export": "Transcript document body.",
    "/drive/v3/files/notes-1/export": "Smart note document body.",
  };
  stubFetch(({ pathname }) => {
    if (fixtures[pathname]) {
      return jsonResponse(fixtures[pathname]);
    }
    if (pathname === "/drive/v3/files/notes-1/export" && options.failSmartNoteDocumentBody) {
      return new Response("insufficientPermissions", { status: 403 });
    }
    const document = documents[pathname];
    return document
      ? new Response(document, { headers: { "Content-Type": "text/plain" } })
      : undefined;
  });
}

export function setupCli(params: {
  config?: Parameters<typeof resolveGoogleMeetConfig>[0];
  runtime?: Partial<GoogleMeetRuntime>;
  ensureRuntime?: () => Promise<GoogleMeetRuntime>;
  callGatewayFromCli?: typeof gatewayRuntime.callGatewayFromCli;
}) {
  vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(
    params.callGatewayFromCli ??
      (async () => {
        throw Object.assign(new Error("gateway transport failed"), {
          name: "GatewayTransportError",
          kind: "closed",
          connectionDetails: { url: "ws://127.0.0.1:18789" },
        });
      }),
  );
  const program = new Command();
  registerGoogleMeetCli({
    program,
    config: resolveGoogleMeetConfig(params.config ?? {}),
    ensureRuntime:
      params.ensureRuntime ?? (async () => (params.runtime ?? {}) as unknown as GoogleMeetRuntime),
  });
  return program;
}
