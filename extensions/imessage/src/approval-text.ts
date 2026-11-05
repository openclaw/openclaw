// A replacement callback keeps approval IDs containing `$` literal.
export function replaceApprovalIdPlaceholder(text: string | undefined, approvalId: string): string {
  return (text ?? "").replace(/\/approve\s+<id>/g, () => `/approve ${approvalId}`);
}
