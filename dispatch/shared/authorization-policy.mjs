const TOOL_POLICIES_RAW = {
  "ticket.create": {
    tool_name: "ticket.create",
    method: "POST",
    endpoint: "/tickets",
    mutating: true,
    requires_ticket_id: false,
    allowed_roles: ["dispatcher", "agent"],
    expected_to_state: "NEW",
    allowed_from_states: null,
  },
  "ticket.triage": {
    tool_name: "ticket.triage",
    method: "POST",
    endpoint: "/tickets/{ticketId}/triage",
    mutating: true,
    requires_ticket_id: true,
    allowed_roles: ["dispatcher", "agent"],
    expected_to_state: "TRIAGED",
    allowed_from_states: ["NEW", "NEEDS_INFO"],
  },
  "schedule.propose": {
    tool_name: "schedule.propose",
    method: "POST",
    endpoint: "/tickets/{ticketId}/schedule/propose",
    mutating: true,
    requires_ticket_id: true,
    allowed_roles: ["dispatcher", "agent"],
    expected_to_state: "SCHEDULE_PROPOSED",
    allowed_from_states: ["READY_TO_SCHEDULE"],
  },
  "schedule.confirm": {
    tool_name: "schedule.confirm",
    method: "POST",
    endpoint: "/tickets/{ticketId}/schedule/confirm",
    mutating: true,
    requires_ticket_id: true,
    allowed_roles: ["dispatcher", "customer"],
    expected_to_state: "SCHEDULED",
    allowed_from_states: ["SCHEDULE_PROPOSED"],
  },
  "assignment.dispatch": {
    tool_name: "assignment.dispatch",
    method: "POST",
    endpoint: "/tickets/{ticketId}/assignment/dispatch",
    mutating: true,
    requires_ticket_id: true,
    allowed_roles: ["dispatcher"],
    expected_to_state: "DISPATCHED",
    allowed_from_states: ["SCHEDULED", "TRIAGED"],
  },
  "tech.check_in": {
    tool_name: "tech.check_in",
    method: "POST",
    endpoint: "/tickets/{ticketId}/tech/check-in",
    mutating: true,
    requires_ticket_id: true,
    allowed_roles: ["tech", "dispatcher"],
    expected_to_state: "IN_PROGRESS",
    allowed_from_states: ["DISPATCHED"],
  },
  "tech.request_change": {
    tool_name: "tech.request_change",
    method: "POST",
    endpoint: "/tickets/{ticketId}/tech/request-change",
    mutating: true,
    requires_ticket_id: true,
    allowed_roles: ["tech"],
    expected_to_state: "APPROVAL_REQUIRED",
    allowed_from_states: ["IN_PROGRESS"],
  },
  "approval.decide": {
    tool_name: "approval.decide",
    method: "POST",
    endpoint: "/tickets/{ticketId}/approval/decide",
    mutating: true,
    requires_ticket_id: true,
    allowed_roles: ["approver", "dispatcher"],
    expected_to_state: null,
    allowed_from_states: ["APPROVAL_REQUIRED"],
  },
  "closeout.add_evidence": {
    tool_name: "closeout.add_evidence",
    method: "POST",
    endpoint: "/tickets/{ticketId}/evidence",
    mutating: true,
    requires_ticket_id: true,
    allowed_roles: ["dispatcher", "agent", "tech"],
    expected_to_state: null,
    allowed_from_states: null,
  },
  "tech.complete": {
    tool_name: "tech.complete",
    method: "POST",
    endpoint: "/tickets/{ticketId}/tech/complete",
    mutating: true,
    requires_ticket_id: true,
    allowed_roles: ["dispatcher", "tech"],
    expected_to_state: "COMPLETED_PENDING_VERIFICATION",
    allowed_from_states: ["IN_PROGRESS"],
  },
  "qa.verify": {
    tool_name: "qa.verify",
    method: "POST",
    endpoint: "/tickets/{ticketId}/qa/verify",
    mutating: true,
    requires_ticket_id: true,
    allowed_roles: ["qa", "dispatcher"],
    expected_to_state: "VERIFIED",
    allowed_from_states: ["COMPLETED_PENDING_VERIFICATION"],
  },
  "billing.generate_invoice": {
    tool_name: "billing.generate_invoice",
    method: "POST",
    endpoint: "/tickets/{ticketId}/billing/generate-invoice",
    mutating: true,
    requires_ticket_id: true,
    allowed_roles: ["finance"],
    expected_to_state: "INVOICED",
    allowed_from_states: ["VERIFIED"],
  },
  "ticket.get": {
    tool_name: "ticket.get",
    method: "GET",
    endpoint: "/tickets/{ticketId}",
    mutating: false,
    requires_ticket_id: true,
    allowed_roles: ["dispatcher", "agent", "customer", "tech", "qa", "approver", "finance"],
    expected_to_state: null,
    allowed_from_states: null,
  },
  "closeout.list_evidence": {
    tool_name: "closeout.list_evidence",
    method: "GET",
    endpoint: "/tickets/{ticketId}/evidence",
    mutating: false,
    requires_ticket_id: true,
    allowed_roles: ["dispatcher", "agent", "tech", "qa", "approver", "finance"],
    expected_to_state: null,
    allowed_from_states: null,
  },
  "ticket.timeline": {
    tool_name: "ticket.timeline",
    method: "GET",
    endpoint: "/tickets/{ticketId}/timeline",
    mutating: false,
    requires_ticket_id: true,
    allowed_roles: ["dispatcher", "agent", "customer", "tech", "qa", "approver", "finance"],
    expected_to_state: null,
    allowed_from_states: null,
  },
};

function freezePolicyMap(map) {
  const entries = Object.entries(map).map(([key, value]) => {
    const copy = {
      ...value,
      allowed_roles: Object.freeze([...(value.allowed_roles ?? [])]),
      allowed_from_states: Array.isArray(value.allowed_from_states)
        ? Object.freeze([...(value.allowed_from_states ?? [])])
        : null,
    };
    return [key, Object.freeze(copy)];
  });
  return Object.freeze(Object.fromEntries(entries));
}

function buildEndpointPolicyMap(toolPolicies) {
  const mutable = {};

  for (const policy of Object.values(toolPolicies)) {
    if (!policy.mutating) {
      continue;
    }

    const current =
      mutable[policy.endpoint] ??
      {
        endpoint: policy.endpoint,
        method: policy.method,
        default_tool_name: policy.tool_name,
        allowed_tool_names: [],
        allowed_roles: new Set(),
        expected_to_state: policy.expected_to_state,
        allowed_from_states: policy.allowed_from_states,
      };

    current.allowed_tool_names.push(policy.tool_name);
    for (const role of policy.allowed_roles) {
      current.allowed_roles.add(role);
    }

    mutable[policy.endpoint] = current;
  }

  const entries = Object.entries(mutable).map(([endpoint, value]) => [
    endpoint,
    Object.freeze({
      endpoint: value.endpoint,
      method: value.method,
      default_tool_name: value.default_tool_name,
      allowed_tool_names: Object.freeze(value.allowed_tool_names),
      allowed_roles: Object.freeze(Array.from(value.allowed_roles)),
      expected_to_state: value.expected_to_state,
      allowed_from_states: value.allowed_from_states,
    }),
  ]);

  return Object.freeze(Object.fromEntries(entries));
}

export const DISPATCH_TOOL_POLICIES = freezePolicyMap(TOOL_POLICIES_RAW);

export const DISPATCH_COMMAND_ENDPOINT_POLICIES = buildEndpointPolicyMap(DISPATCH_TOOL_POLICIES);

export function getDispatchToolPolicy(toolName) {
  if (typeof toolName !== "string") {
    return null;
  }
  return DISPATCH_TOOL_POLICIES[toolName] ?? null;
}

export function getCommandEndpointPolicy(endpoint) {
  if (typeof endpoint !== "string") {
    return null;
  }
  return DISPATCH_COMMAND_ENDPOINT_POLICIES[endpoint] ?? null;
}

export function isRoleAllowedForCommandEndpoint(endpoint, actorRole) {
  const policy = getCommandEndpointPolicy(endpoint);
  if (!policy || typeof actorRole !== "string") {
    return false;
  }
  return policy.allowed_roles.includes(actorRole.toLowerCase());
}

export function isToolAllowedForCommandEndpoint(endpoint, toolName) {
  const policy = getCommandEndpointPolicy(endpoint);
  if (!policy || typeof toolName !== "string") {
    return false;
  }
  return policy.allowed_tool_names.includes(toolName);
}
