import { stylePromptHint, stylePromptMessage } from "./prompt-style.js";

// Pure prompt parameter styler used by interactive prompts and tests.

/** Minimal select-like params accepted by the prompt styler. */
type SelectParamsLike = {
  message: string;
  options: readonly object[];
};

/** Return select params with styled prompt message and per-option hints. */
export function styleSelectParams<TParams extends SelectParamsLike>(params: TParams): TParams {
  return {
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) => {
      const hint = "hint" in opt && typeof opt.hint === "string" ? opt.hint : undefined;
      return hint === undefined ? opt : { ...opt, hint: stylePromptHint(hint) };
    }),
  } as TParams;
}
