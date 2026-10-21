import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMatrixCli } from "./cli.js";

const fixture = vi.hoisted(() => ({
  admit: vi.fn<typeof import("openclaw/plugin-sdk/cli-state-owner").runWithLocalStateOwner>(),
  config: vi.fn(),
  verification: vi.fn(),
}));

// mock-isolation: Core proves physical ownership; this fixture observes plugin admission.
vi.mock("openclaw/plugin-sdk/cli-state-owner", () => ({
  runWithLocalStateOwner: fixture.admit,
}));

// mock-isolation: No crypto runtime is needed to observe the CLI admission boundary.
vi.mock("./matrix/actions/verification.js", () => ({
  acceptMatrixVerification: fixture.verification,
  bootstrapMatrixVerification: fixture.verification,
  cancelMatrixVerification: fixture.verification,
  confirmMatrixVerificationSas: fixture.verification,
  getMatrixRoomKeyBackupStatus: fixture.verification,
  getMatrixVerificationSas: fixture.verification,
  getMatrixVerificationStatus: fixture.verification,
  listMatrixVerifications: fixture.verification,
  mismatchMatrixVerificationSas: fixture.verification,
  requestMatrixVerification: fixture.verification,
  resetMatrixRoomKeyBackup: fixture.verification,
  restoreMatrixRoomKeyBackup: fixture.verification,
  runMatrixSelfVerification: fixture.verification,
  startMatrixVerification: fixture.verification,
  verifyMatrixRecoveryKey: fixture.verification,
}));

// mock-isolation: Refusal must precede loading account config or creating a Matrix runtime.
vi.mock("./runtime.js", () => ({
  getMatrixRuntime: () => ({ config: { current: fixture.config } }),
  setMatrixRuntimeLifecycle: () => {},
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = 0;
});

describe("Matrix verification CLI owner admission", () => {
  it.each([
    [["list"], "matrix.cli"],
    [["sas", "fixture"], "matrix.cli"],
    [["self"], "matrix.cli"],
    [["request"], "matrix.cli"],
    [["start", "fixture"], "matrix.cli"],
    [["accept", "fixture"], "matrix.cli"],
    [["confirm-sas", "fixture"], "matrix.cli"],
    [["mismatch-sas", "fixture"], "matrix.cli"],
    [["cancel", "fixture"], "matrix.cli"],
    [["status"], "matrix.verify.status.owner"],
    [["bootstrap"], "matrix.verify.bootstrap.owner"],
    [["device", "synthetic-key"], "matrix.verify.recoveryKey.owner"],
    [["backup", "status"], "matrix.cli"],
    [["backup", "reset", "--yes"], "matrix.cli"],
    [["backup", "restore"], "matrix.cli"],
  ] as const)("admits %j through %s before account access", async (args, method) => {
    fixture.admit.mockRejectedValueOnce(new Error("fixture owner refused"));
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    const json = args[0] !== "self";
    const program = new Command();
    registerMatrixCli({ program });

    await program.parseAsync(
      ["matrix", "verify", ...args, "--account", "ops", ...(json ? ["--json"] : [])],
      {
        from: "user",
      },
    );

    expect(fixture.admit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ method, runLocal: expect.any(Function) }),
    );
    const admission = fixture.admit.mock.calls[0]?.[0];
    expect(admission?.onForeignOwner).toBe(method === "matrix.cli" ? "refuse" : undefined);
    if (method !== "matrix.cli") {
      expect(admission?.params).toMatchObject({ accountId: "ops" });
    }
    expect(fixture.config).not.toHaveBeenCalled();
    expect(fixture.verification).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(json ? output : diagnostics).toHaveBeenCalledWith(
      expect.stringContaining("fixture owner refused"),
    );
  });
});
