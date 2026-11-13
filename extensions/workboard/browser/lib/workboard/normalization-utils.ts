import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";

export function formatError(error: unknown): string {
  return formatUiError(error, t("workboard.unknownError"));
}
