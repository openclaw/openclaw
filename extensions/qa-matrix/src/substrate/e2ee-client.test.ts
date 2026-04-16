import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing } from "./e2ee-client.js";

describe("matrix qa e2ee client storage", () => {
  it("scopes persisted crypto state to the account actor", () => {
    const first = __testing.buildMatrixQaE2eeStoragePaths({
      actorId: "driver",
      outputDir: "/tmp/openclaw/.artifacts/qa-e2e/matrix-run",
      scenarioId: "matrix-e2ee-basic-reply",
    });
    const second = __testing.buildMatrixQaE2eeStoragePaths({
      actorId: "driver",
      outputDir: "/tmp/openclaw/.artifacts/qa-e2e/matrix-run",
      scenarioId: "matrix-e2ee-qr-verification",
    });

    expect(first.accountDir).toBe(
      path.join(
        "/tmp/openclaw/.artifacts/qa-e2e/matrix-run",
        "matrix-e2ee",
        "accounts",
        "driver",
        "account",
      ),
    );
    expect(first.cryptoDatabasePrefix).toBe(second.cryptoDatabasePrefix);
    expect(first.recoveryKeyPath).toBe(path.join(first.accountDir, "recovery-key.json"));
  });
});
