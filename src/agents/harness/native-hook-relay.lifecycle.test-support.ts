import { expect, type Mock } from "vitest";

export async function expectConcurrentRelayOwnerPreservesPreparation(params: {
  preparation: Promise<void>;
  invoke: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  policy: Mock;
}): Promise<void> {
  await expect(params.preparation).resolves.toBeUndefined();
  const response = await params.invoke();
  expect(response.exitCode).toBe(0);
  expect(JSON.parse(response.stdout)).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
  expect(params.policy).toHaveBeenCalledOnce();
}
