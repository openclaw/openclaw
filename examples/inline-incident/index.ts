import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// Synthetic, shared demo records; intentionally reset on plugin reload.
const incidents = new Map([
  [
    "INC-42",
    {
      incidentId: "INC-42",
      title: "Elevated checkout latency",
      service: "Checkout API",
      severity: "SEV 2",
      status: "Investigating",
      acknowledged: false,
    },
  ],
  [
    "INC-43",
    {
      incidentId: "INC-43",
      title: "Delayed search indexing",
      service: "Search",
      severity: "SEV 3",
      status: "Monitoring",
      acknowledged: false,
    },
  ],
]);

export default definePluginEntry({
  id: "incident-tools",
  name: "Incident tools",
  description: "Show a predefined native incident dashboard.",
  register(api) {
    api.session.controls.registerControlUiDescriptor({
      id: "incident-dashboard",
      surface: "inline",
      label: "Incident dashboard",
      requiredScopes: ["operator.read"],
      version: 1,
    });
    api.registerTool({
      name: "show_incident",
      label: "Show incident",
      description: "Show incident INC-42 or INC-43 in the conversation.",
      parameters: {
        type: "object",
        properties: { incidentId: { type: "string", enum: ["INC-42", "INC-43"] } },
        required: ["incidentId"],
      },
      async execute(_toolCallId, args: { incidentId: string }) {
        const incident = incidents.get(args.incidentId);
        if (!incident) {
          throw new Error("Unknown demo incident. Choose INC-42 or INC-43.");
        }
        return api.inlineView(
          "incident-dashboard",
          { incidentId: incident.incidentId },
          {
            version: 1,
            summary: incident.incidentId + ": " + incident.title + " — " + incident.status + ".",
          },
        );
      },
    });
    // Gateway dispatch enforces the current viewer's scope, not the tool caller's.
    // All demo records are shared. Real backends must also check that viewer's record ACL.
    api.registerGatewayMethod(
      "incident-tools.get",
      ({ params, respond }) => {
        const incident =
          typeof params.incidentId === "string" ? incidents.get(params.incidentId) : undefined;
        if (!incident) {
          respond(false, undefined, { code: "INVALID_REQUEST", message: "Unknown demo incident." });
          return;
        }
        respond(true, incident);
      },
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "incident-tools.acknowledge",
      ({ params, respond }) => {
        const incident =
          typeof params.incidentId === "string" ? incidents.get(params.incidentId) : undefined;
        if (!incident) {
          respond(false, undefined, { code: "INVALID_REQUEST", message: "Unknown demo incident." });
          return;
        }
        const acknowledged = { ...incident, acknowledged: true };
        incidents.set(incident.incidentId, acknowledged);
        respond(true, acknowledged);
      },
      { scope: "operator.write" },
    );
  },
});
