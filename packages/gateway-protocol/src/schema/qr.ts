// Gateway Protocol QR schemas share the established PNG data-URL contract.
import { Type } from "typebox";

export const QR_PNG_DATA_URL_MAX_LENGTH = 16_384;
export const QR_PNG_DATA_URL_PREFIX = "data:image/png;base64,";

const QR_PNG_DATA_URL_PATTERN =
  "^data:image/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)$";

export const QrPngDataUrlSchema = Type.String({
  maxLength: QR_PNG_DATA_URL_MAX_LENGTH,
  pattern: QR_PNG_DATA_URL_PATTERN,
});
