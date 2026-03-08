import type { VentureResult } from "./result-schema.js";
import type { VentureRunContext } from "./run-context.js";
import type { VentureModuleDescriptor } from "./types.js";

export type VentureValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export interface VentureModule<
  TInput = unknown,
  TPlan = Record<string, unknown>,
  TOutput = Record<string, unknown>,
> {
  readonly descriptor: VentureModuleDescriptor;
  plan(input: TInput, ctx: VentureRunContext): Promise<TPlan>;
  execute(plan: TPlan, ctx: VentureRunContext): Promise<TOutput>;
  validate(output: TOutput, ctx: VentureRunContext): Promise<VentureValidationResult>;
  report(output: TOutput, validation: VentureValidationResult, ctx: VentureRunContext): Promise<VentureResult>;
}

