import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_STORE_OPTIONS,
  ShellgateCredentials,
  type ShellgateCredential,
} from "./credentials.js";
import { verifyShellgateRequest } from "./http.js";

describe("Shellgate proxy credential boundary", () => {
  let stateDir: string;
  let server: Server;
  let url: string;
  let credentials: ShellgateCredentials;
  let store: ReturnType<typeof createPluginStateKeyedStoreV2ForTests<ShellgateCredential>>;

  function openStore() {
    return createPluginStateKeyedStoreV2ForTests<ShellgateCredential>(
      "shellgate",
      { ...CREDENTIAL_STORE_OPTIONS, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
      { assertCurrent: () => {} },
    );
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "shellgate-"));
    store = openStore();
    credentials = new ShellgateCredentials(store);
    server = createServer((req, res) => {
      void verifyShellgateRequest(req, res, credentials);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing fixture listener");
    }
    url = `http://127.0.0.1:${address.port}/plugins/shellgate/verify`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await rm(stateDir, { recursive: true, force: true });
  });

  const verify = (token: string) => fetch(url, { headers: { authorization: `Bearer ${token}` } });

  it("keeps human/service bindings durable and makes rotation and revocation effective on the next request", async () => {
    const human = await credentials.issue("alice@example.test");
    const service = await credentials.issue("local:build-service");
    for (const scheme of ["Bearer ", "bEaReR ", "Bearer   "]) {
      const response = await fetch(url, { headers: { authorization: scheme + human.token } });
      expect(response.status).toBe(204);
      expect(response.headers.get("x-shellgate-user")).toBe(human.subject);
    }
    for (const issued of [human, service]) {
      const response = await verify(issued.token);
      expect(response.status).toBe(204);
      expect(response.headers.get("x-shellgate-user")).toBe(issued.subject);
      expect(response.headers.get("x-openclaw-scopes")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(await store.lookup(issued.id)).toEqual({
        subject: issued.subject,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        createdAt: issued.createdAt,
      });
    }
    const listed = await credentials.list();
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain("digest");
    expect(JSON.stringify(listed)).not.toContain(human.token);
    const replacement = await credentials.rotate(human.id);
    expect(replacement.id).toBe(human.id);
    expect(replacement.subject).toBe(human.subject);
    expect((await verify(human.token)).status).toBe(401);
    expect((await verify(replacement.token)).status).toBe(204);
    expect(await credentials.revoke(human.id)).toEqual({ id: human.id, revoked: true });
    expect(await credentials.revoke(human.id)).toEqual({ id: human.id, revoked: false });
    expect((await verify(replacement.token)).status).toBe(401);

    // Exercise actual SQLite close/reopen, not another wrapper over an in-memory map.
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    store = openStore();
    credentials = new ShellgateCredentials(store);
    expect((await verify(service.token)).headers.get("x-shellgate-user")).toBe(
      "local:build-service",
    );
    expect((await verify(replacement.token)).status).toBe(401);
    expect(await credentials.list()).toEqual([
      { id: service.id, subject: service.subject, createdAt: service.createdAt },
    ]);
  });

  it("does not accept identity claims, Basic credentials, malformed tokens, or a changed secret", async () => {
    const issued = await credentials.issue("local:operator");
    for (const authorization of [
      undefined,
      "Basic c3ludGhldGljOm9ubHk=",
      "Bearer invalid",
      `Bearer ${issued.token.slice(0, -1)}!`,
    ]) {
      const response = await fetch(url, {
        headers: {
          ...(authorization ? { authorization } : {}),
          "x-forwarded-user": "local:administrator",
          "x-shellgate-user": "local:administrator",
          "x-openclaw-scopes": "operator.admin",
        },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("x-shellgate-user")).toBeNull();
      expect(response.headers.get("x-openclaw-scopes")).toBeNull();
    }
    const replacementCharacter = issued.token.endsWith("A") ? "B" : "A";
    expect((await verify(`${issued.token.slice(0, -1)}${replacementCharacter}`)).status).toBe(401);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
  });

  it("rejects ambiguous subjects and fails closed without exposing storage failures", async () => {
    for (const subject of [
      "Alice@example.test",
      "",
      "local:alice\r\nx-openclaw-scopes: operator.admin",
      "local:with space",
      "a".repeat(257),
    ]) {
      await expect(credentials.issue(subject)).rejects.toThrow("Subject must be");
    }
    expect(await credentials.list()).toEqual([]);
    const issued = await credentials.issue("local:operator");
    vi.spyOn(store, "lookup").mockRejectedValue(
      new Error(`synthetic storage error ${issued.token}`),
    );
    const response = await verify(issued.token);
    expect(response.status).toBe(503);
    expect(response.headers.get("x-shellgate-user")).toBeNull();
    expect(await response.text()).toBe("");
  });
});
