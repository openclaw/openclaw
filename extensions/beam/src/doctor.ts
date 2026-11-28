import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";

export async function runBeamDoctor(
  options: { json?: boolean },
  resolveBeamExecutable: () => Promise<string>,
): Promise<void> {
  const platform = `${process.platform}-${process.arch}`;
  const status = await resolveBeamExecutable().then(
    () => ({ ok: true, platform, message: `The Beam outbound cleaner is ready on ${platform}.` }),
    (cause: unknown) => ({
      ok: false,
      platform,
      message:
        cause instanceof Error ? cause.message : "Unable to verify the Beam outbound cleaner.",
    }),
  );
  if (options.json) {
    defaultRuntime.writeJson(status);
  } else {
    defaultRuntime.log(status.message);
  }
  if (!status.ok) {
    defaultRuntime.exit(1);
  }
}
