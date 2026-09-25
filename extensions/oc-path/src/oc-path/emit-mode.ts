import { OcEmitSentinelError, REDACTED_SENTINEL } from "./sentinel.js";

export interface EmitOptions {
  readonly mode?: "roundtrip" | "render";
  readonly fileNameForGuard?: string;
  /** Round-trip trusts parsed bytes by default; render guards remain per-kind. */
  readonly acceptPreExistingSentinel?: boolean;
}

export function emitWithMode(
  ast: { readonly raw: string },
  opts: EmitOptions,
  render: (guardPath: string, acceptPreExisting: boolean) => string,
): string {
  const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : "oc://";
  const acceptPreExisting = opts.acceptPreExistingSentinel ?? true;
  if ((opts.mode ?? "roundtrip") === "roundtrip") {
    if (!acceptPreExisting && ast.raw.includes(REDACTED_SENTINEL)) {
      throw new OcEmitSentinelError(`${guardPath}/[raw]`);
    }
    return ast.raw;
  }
  return render(guardPath, acceptPreExisting);
}
