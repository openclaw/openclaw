import * as Checks from "./compiled/protocol.generated/approval-result-validators.js";
import { createProtocolValidator } from "./protocol-validator.js";
import {
  type ApprovalDecision,
  type ApprovalGetResult,
  ApprovalGetResultSchema,
  type ApprovalHistoryResult,
  ApprovalHistoryResultSchema,
  type ApprovalPresentation,
  ApprovalPresentationSchema,
  type ApprovalResolveResult,
  ApprovalResolveResultSchema,
  type ApprovalSnapshot,
} from "./schema/approvals.js";

export type {
  ApprovalDecision,
  ApprovalGetResult,
  ApprovalHistoryResult,
  ApprovalPresentation,
  ApprovalResolveResult,
  ApprovalSnapshot,
};

export const validateApprovalGetResult = createProtocolValidator(
  ApprovalGetResultSchema,
  Checks.isApprovalGetResult,
);
export const validateApprovalHistoryResult = createProtocolValidator(
  ApprovalHistoryResultSchema,
  Checks.isApprovalHistoryResult,
);
export const validateApprovalResolveResult = createProtocolValidator(
  ApprovalResolveResultSchema,
  Checks.isApprovalResolveResult,
);
export const validateApprovalPresentation = createProtocolValidator(
  ApprovalPresentationSchema,
  Checks.isApprovalPresentation,
);
