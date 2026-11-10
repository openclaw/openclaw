import * as Checks from "./compiled/protocol.generated/terminal-validators.js";
import { createProtocolValidator } from "./protocol-validator.js";
import {
  TerminalAttachParamsSchema,
  TerminalCloseParamsSchema,
  TerminalInputParamsSchema,
  TerminalOpenParamsSchema,
  TerminalResizeParamsSchema,
  TerminalUploadParamsSchema,
  TerminalUploadResultSchema,
} from "./schema/terminal.js";

export const validateTerminalOpenParams = createProtocolValidator(
  TerminalOpenParamsSchema,
  Checks.isTerminalOpenParams,
);
export const validateTerminalInputParams = createProtocolValidator(
  TerminalInputParamsSchema,
  Checks.isTerminalInputParams,
);
export const validateTerminalResizeParams = createProtocolValidator(
  TerminalResizeParamsSchema,
  Checks.isTerminalResizeParams,
);
export const validateTerminalCloseParams = createProtocolValidator(
  TerminalCloseParamsSchema,
  Checks.isTerminalCloseParams,
);
export const validateTerminalAttachParams = createProtocolValidator(
  TerminalAttachParamsSchema,
  Checks.isTerminalAttachParams,
);
export const validateTerminalUploadParams = createProtocolValidator(
  TerminalUploadParamsSchema,
  Checks.isTerminalUploadParams,
);
export const validateTerminalUploadResult = createProtocolValidator(
  TerminalUploadResultSchema,
  Checks.isTerminalUploadResult,
);
