// Version handling (docs/versioning.md): a well-formed version this build does not implement is
// `unsupported_version`, checked before anything else; anything else is `malformed`.
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/v1-draft/statements.json" with { type: "json" };
import { submitStatement } from "./authority/apply.js";
import { parseClawDescriptor, type ClawDescriptor } from "./discovery/descriptor.js";
import { statementDomain } from "./statements/envelope.js";
import type { SignedStatement } from "./statements/types.js";
import { parseStatement } from "./statements/validate.js";
import type { StatementVectors } from "./testing/vectors.js";
import { buildWorld, signChange, WORLD_NOW } from "./testing/world.js";

const vectors = fixture as unknown as StatementVectors;
const binding = vectors.valid.find((entry) => entry.name === "root signs server binding seq 1")!
  .statement as SignedStatement<"ServerBinding">;
const descriptor: ClawDescriptor = {
  v: 1,
  claw_id: binding.body.claw_id,
  transport: "iroh",
  relay_url: "https://relay.example.test/",
  root_pub: vectors.kit.root_pub,
  binding,
  published_at: vectors.now,
};

describe("statement envelope versions", () => {
  it("keeps the v1 signing domain", () => {
    expect(statementDomain("ServerBinding")).toBe("openclaw/ServerBinding/v1\0");
    expect(statementDomain("ServerBinding", 1)).toBe("openclaw/ServerBinding/v1\0");
  });

  it("refuses a later envelope version as unsupported, before its type or fields", () => {
    for (const later of [
      { ...binding, v: 2 },
      { ...binding, v: 2, type: "RootHandover" },
      { ...binding, v: 2, extension: {} },
    ]) {
      expect(parseStatement(later)).toMatchObject({ ok: false, code: "unsupported_version" });
    }
  });

  it("refuses a missing or invalid envelope version as malformed", () => {
    const { v: _v, ...unversioned } = binding;
    expect(parseStatement(unversioned)).toMatchObject({ ok: false, code: "malformed" });
    for (const v of [null, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseStatement({ ...binding, v })).toMatchObject({ ok: false, code: "malformed" });
    }
  });

  it("reports an unsupported version through the authority without changing state", async () => {
    const world = await buildWorld();
    const change = await signChange(world.state, world.device1.signer, {
      op: "remove",
      account_id: "acct_bob",
    });
    const result = await submitStatement(
      world.state,
      { ...change, v: 2 },
      { channel: "tunnel", now: WORLD_NOW },
    );
    expect(result).toMatchObject({ ok: false, code: "unsupported_version", events: [] });
    expect(result.state).toBe(world.state);
  });
});

describe("descriptor versions", () => {
  it("refuses a later descriptor version as unsupported, before unknown fields", () => {
    expect(parseClawDescriptor({ ...descriptor, v: 2 })).toMatchObject({
      ok: false,
      code: "unsupported_version",
    });
    expect(parseClawDescriptor({ ...descriptor, v: 2, transports: [] })).toMatchObject({
      ok: false,
      code: "unsupported_version",
    });
  });

  it("refuses a missing descriptor version as malformed", () => {
    const { v: _v, ...unversioned } = descriptor;
    expect(parseClawDescriptor(unversioned)).toMatchObject({ ok: false, code: "malformed" });
  });

  it("passes on a binding envelope version it does not implement", () => {
    expect(parseClawDescriptor({ ...descriptor, binding: { ...binding, v: 2 } })).toMatchObject({
      ok: false,
      code: "unsupported_version",
    });
  });
});
