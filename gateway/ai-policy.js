// PPM AI Assistant Operational Policy Enforcement (integrated for OpenClaw Gateway)
// This module should be imported and called in your gateway logic before responding to user/API requests.

/**
 * Checks if a request should be blocked or escalated based on PPM AI policy rules.
 * Returns { allowed: boolean, response: string|null, escalate: boolean }
 */
export function enforceAIPolicy({
  user: _user,
  requestType,
  accountStatus,
  isVerified,
  isOwnerOrAuthorized,
  isEmergency,
  isLegal,
  isSensitive,
  isBoard,
  isViolation,
  isPayment,
  isFinancial,
  isLegalThreat,
  isHostile,
  isMedia,
  requestedInfo
}) {
  // 1. Attorney / Collections Accounts
  if (['Attorney', 'Collections'].includes(accountStatus) &&
      ['balance','payment status','payment history','ledger','payoff amount','collections status'].includes(requestType)) {
    return {
      allowed: false,
      response: "Because this account has been referred to collections or legal counsel, we’re unable to provide financial details through this system. Please contact property management or the association’s attorney for assistance.",
      escalate: false
    };
  }
  // 2. Financial Privacy Protection
  if (isFinancial && (!isVerified || !isOwnerOrAuthorized)) {
    return {
      allowed: false,
      response: "For privacy reasons, we can only provide account details to verified owners or authorized contacts. Please contact property management for assistance.",
      escalate: false
    };
  }
  // 3. Legal Advice Restrictions
  if (isLegal) {
    return {
      allowed: false,
      response: "Questions involving legal interpretation should be directed to property management or the association’s legal counsel.",
      escalate: false
    };
  }
  // 4. Governing Document Interpretation
  if (requestType === 'governing_document_interpretation') {
    return {
      allowed: false,
      response: "I can quote governing documents and provide section references, but cannot interpret or make enforcement judgments.",
      escalate: false
    };
  }
  // 5. Maintenance Requests
  if (requestType === 'maintenance_diagnosis' || requestType === 'maintenance_approval') {
    return {
      allowed: false,
      response: "I can help you submit a maintenance request or provide portal instructions, but cannot diagnose problems or authorize repairs.",
      escalate: false
    };
  }
  // 6. Emergency Situations
  if (isEmergency) {
    return {
      allowed: false,
      response: "If this is an emergency, please contact emergency services or the association’s emergency maintenance line immediately.",
      escalate: true
    };
  }
  // 7. Payment Processing
  if (isPayment && requestedInfo === 'collect_payment_info') {
    return {
      allowed: false,
      response: "I cannot accept payment information. Please use the payment portal or mailing instructions provided.",
      escalate: false
    };
  }
  // 8. Violation Notices
  if (isViolation && (requestType === 'issue_violation' || requestType === 'determine_guilt' || requestType === 'issue_fine')) {
    return {
      allowed: false,
      response: "I can explain violation processes and appeal instructions, but cannot issue notices, determine guilt, or override enforcement decisions.",
      escalate: false
    };
  }
  // 9. Board Communication
  if (isBoard && (requestType === 'announce_board_ruling' || requestType === 'speak_for_board')) {
    return {
      allowed: false,
      response: "I can provide meeting dates, document access, and contact instructions, but cannot announce board rulings or speak on behalf of board members.",
      escalate: false
    };
  }
  // 10. Confidential Information Protection
  if (isSensitive) {
    return {
      allowed: false,
      response: "I cannot disclose confidential or personal information.",
      escalate: true
    };
  }
  // 11. Escalation to Staff
  if (isLegalThreat || isHostile || !isVerified || requestType === 'dispute' || requestType === 'exception') {
    return {
      allowed: false,
      response: "Your request will be escalated to property management for review.",
      escalate: true
    };
  }
  // 12. Sensitive Communication
  if (isLegalThreat || isHostile || isMedia) {
    return {
      allowed: false,
      response: "This conversation will be escalated to management for further review.",
      escalate: true
    };
  }
  // 13. Data Protection
  if (requestedInfo && ['ssn','social security','bank account','credit card','driver license'].some(s => requestedInfo.toLowerCase().includes(s))) {
    return {
      allowed: false,
      response: "I cannot store or display sensitive personal data.",
      escalate: false
    };
  }
  // 14. Logging and Transparency (handled by gateway logging)
  // 15. Tone and Professional Conduct (handled by LLM prompt/response)
  return { allowed: true, response: null, escalate: false };
}

// Usage: Call enforceAIPolicy() with the relevant context before fulfilling a request.
// Example integration in your gateway logic:
//   const policy = enforceAIPolicy({ user, requestType, ... });
//   if (!policy.allowed) { return res.json({ message: policy.response }); }
//   // else proceed with normal logic
