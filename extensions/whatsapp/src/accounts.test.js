import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWhatsAppAuthDir } from "./accounts.js";
describe("resolveWhatsAppAuthDir", () => {
  const stubCfg = { channels: { whatsapp: { accounts: {} } } };
  it("sanitizes path traversal sequences in accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: stubCfg,
      accountId: "../../../etc/passwd"
    });
    expect(authDir).not.toContain("..");
    expect(path.basename(authDir)).not.toContain("/");
  });
  it("sanitizes special characters in accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: stubCfg,
      accountId: "foo/bar\\baz"
    });
    const segment = path.basename(authDir);
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("\\");
  });
  it("returns default directory for empty accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: stubCfg,
      accountId: ""
    });
    expect(authDir).toMatch(/whatsapp[/\\]default$/);
  });
  it("preserves valid accountId unchanged", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: stubCfg,
      accountId: "my-account-1"
    });
    expect(authDir).toMatch(/whatsapp[/\\]my-account-1$/);
  });
});
