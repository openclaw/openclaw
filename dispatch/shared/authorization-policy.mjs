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
