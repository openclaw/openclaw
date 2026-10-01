import fsSync from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { logWebSelfId } from "./auth-store.js";
import {
  cleanupSessionTest,
  createTempAuthDir,
  expectRuntimeLogContaining,
  resetSessionTestMocks,
} from "./session-test-helpers.js";

let session!: typeof import("./session.js");

describe("web session identity and errors", () => {
  beforeAll(async () => {
    session = await import("./session.js");
  });

  beforeEach(() => {
    resetSessionTestMocks();
  });

  afterEach(async () => {
    await cleanupSessionTest(session.waitForCredsSaveQueue);
  });

  it("logWebSelfId prints cached E.164 when creds exist", () => {
    const authDir = createTempAuthDir("openclaw-wa-log-self");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json"),
      JSON.stringify({ me: { id: "12345@s.whatsapp.net" } }),
      "utf-8",
    );
    const runtime = createRuntimeSpies();

    logWebSelfId(authDir, runtime as never, true);

    expectRuntimeLogContaining(runtime, "Web Channel: +12345 (jid 12345@s.whatsapp.net)");
  });

  it("logWebSelfId prints cached lid details when creds include a lid", () => {
    const authDir = createTempAuthDir("openclaw-wa-log-self-lid");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json"),
      JSON.stringify({
        me: {
          id: "12345@s.whatsapp.net",
          lid: "777@lid",
        },
      }),
      "utf-8",
    );
    const runtime = createRuntimeSpies();

    logWebSelfId(authDir, runtime as never, true);

    expectRuntimeLogContaining(
      runtime,
      "Web Channel: +12345 (jid 12345@s.whatsapp.net, lid 777@lid)",
    );
  });

  it("formatError prints Boom-like payload message", () => {
    const err = {
      error: {
        isBoom: true,
        output: {
          statusCode: 408,
          payload: {
            statusCode: 408,
            error: "Request Time-out",
            message: "QR refs attempts ended",
          },
        },
      },
    };
    expect(session.formatError(err)).toContain("status=408");
    expect(session.formatError(err)).toContain("Request Time-out");
    expect(session.formatError(err)).toContain("QR refs attempts ended");
  });

  it("formatError keeps truncated object details free of lone surrogates", () => {
    const emptyEnvelope = JSON.stringify({ detail: "" }, null, 2);
    const insertionIndex = emptyEnvelope.indexOf('""') + 1;
    const detail = `${"a".repeat(799 - insertionIndex)}😀tail`;
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

    const result = session.formatError({ detail });

    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toMatch(loneSurrogate);
  });
});
