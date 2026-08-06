// Gateway Protocol QR schemas share the established PNG data-URL contract.
import { Type } from "typebox";

export const QR_PNG_DATA_URL_MAX_LENGTH = 16_384;
export const QR_PNG_DATA_URL_PREFIX = "data:image/png;base64,";

// The first 11 base64 characters encode the eight-byte PNG signature. The final
// character also carries two bits from the next byte, hence the `o-r` range.
const QR_PNG_BASE64_PREFIX_PATTERN = "iVBORw0KGg[o-r]";
const QR_PNG_DATA_URL_PATTERN = `^${QR_PNG_DATA_URL_PREFIX}${QR_PNG_BASE64_PREFIX_PATTERN}(?:=|[A-Za-z0-9+/](?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?)$`;

export const QrPngDataUrlSchema = Type.String({
  maxLength: QR_PNG_DATA_URL_MAX_LENGTH,
  pattern: QR_PNG_DATA_URL_PATTERN,
});
