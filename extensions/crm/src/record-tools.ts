import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { crmRequest } from "./client.js";
import {
  ENTITY_PATH,
  createConfig,
  entitySchema,
  listFiltersSchema,
  nonEmptyString,
  readData,
  readEntity,
  readFilters,
  readOptionalBoolean,
  readOptionalInteger,
  readCrmTextParam,
  readRequiredString,
  requireDealStage,
  requireField,
} from "./tool-schema.js";

export function crmSearchTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "crm_search",
    label: "CRM Search",
    description:
      "Search a self-hosted CRM for matching contacts, companies, and deals. Returns up to five quick hits per record kind.",
    parameters: Type.Object(
      {
        query: nonEmptyString("Name, email, domain, or deal title (at least 2 characters)."),
      },
      { additionalProperties: false },
    ),
    resultContentSource: "network",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const query = readRequiredString(
        asOptionalRecord(params) ?? {},
        "query",
        "name, email, domain, or deal title",
      );
      if (query.length < 2) {
        throw new Error("query must be at least 2 characters.");
      }
      return jsonResult(
        await crmRequest(createConfig(api), {
          method: "GET",
          path: "/search",
          query: { q: query },
          ...(signal ? { signal } : {}),
        }),
      );
    },
  };
}

export function crmListRecordsTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "crm_list_records",
    label: "CRM List Records",
    description:
      "List or filter CRM records with pagination. Use filters to narrow by owner, company, stage, industry, source, activity window, and similar list facets. Returns rows, total, and facet counts.",
    parameters: Type.Object(
      {
        entity: entitySchema,
        query: Type.Optional(
          Type.String({ description: "Free-text search within the record kind." }),
        ),
        page: Type.Optional(Type.Integer({ minimum: 1, description: "Page number (default 1)." })),
        pageSize: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 100, description: "Rows per page (default 25)." }),
        ),
        archived: Type.Optional(
          Type.Boolean({
            description: "List archived records instead of active ones (default false).",
          }),
        ),
        filters: listFiltersSchema,
      },
      { additionalProperties: false },
    ),
    resultContentSource: "network",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const args = asOptionalRecord(params) ?? {};
      const entity = readEntity(args);
      const body: Record<string, unknown> = {};

      const query = readCrmTextParam(args, "query");
      if (query !== undefined) {
        body.q = query;
      }

      const page = readOptionalInteger(args, "page", { min: 1, max: 1_000_000 });
      if (page !== undefined) {
        body.page = page;
      }

      const pageSize = readOptionalInteger(args, "pageSize", { min: 1, max: 100 });
      if (pageSize !== undefined) {
        body.pageSize = pageSize;
      }

      const archived = readOptionalBoolean(args, "archived");
      if (archived !== undefined) {
        body.archived = archived;
      }

      const filters = readFilters(args, entity);
      if (filters) {
        Object.assign(body, filters);
      }

      return jsonResult(
        await crmRequest(createConfig(api), {
          method: "POST",
          path: `/${ENTITY_PATH[entity]}/search`,
          body,
          ...(signal ? { signal } : {}),
        }),
      );
    },
  };
}

export function crmGetRecordTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "crm_get_record",
    label: "CRM Get Record",
    description:
      "Read one CRM record by id, including its full detail view (relationships, custom fields, deal pipeline data).",
    parameters: Type.Object(
      {
        entity: entitySchema,
        id: nonEmptyString("Record id."),
      },
      { additionalProperties: false },
    ),
    resultContentSource: "network",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const args = asOptionalRecord(params) ?? {};
      const entity = readEntity(args);
      const id = readRequiredString(args, "id", "CRM record id");
      return jsonResult(
        await crmRequest(createConfig(api), {
          method: "GET",
          path: `/${ENTITY_PATH[entity]}/${encodeURIComponent(id)}`,
          ...(signal ? { signal } : {}),
        }),
      );
    },
  };
}

export function crmCreateRecordTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "crm_create_record",
    label: "CRM Create Record",
    description:
      "Create a contact, company, or deal. Required data: contact firstName; company name; deal name, companyId, and ownerId. Deal stage defaults to the CRM pipeline start. Company create accepts only name, domain, and ownerId; use crm_update_record afterwards for other company fields.",
    parameters: Type.Object(
      {
        entity: entitySchema,
        data: Type.Record(Type.String(), Type.Unknown(), {
          description: "Entity fields to create.",
        }),
      },
      { additionalProperties: false },
    ),
    resultContentSource: "network",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const args = asOptionalRecord(params) ?? {};
      const entity = readEntity(args);
      const data = readData(args, entity, "create");

      if (entity === "contact") {
        requireField(data, "firstName", entity);
      } else if (entity === "company") {
        requireField(data, "name", entity);
      } else {
        requireField(data, "name", entity);
        requireField(data, "companyId", entity);
        requireField(data, "ownerId", entity);
        if (data.stage !== undefined) {
          data.stage = requireDealStage(data.stage);
        }
      }

      return jsonResult(
        await crmRequest(createConfig(api), {
          method: "POST",
          path: `/${ENTITY_PATH[entity]}`,
          body: data,
          ...(signal ? { signal } : {}),
        }),
      );
    },
  };
}

export function crmUpdateRecordTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "crm_update_record",
    label: "CRM Update Record",
    description:
      "Update fields on an existing contact, company, or deal. Pass only the fields that change. For deals, stage changes are routed through the CRM stage endpoint and require closedReason when moving to CLOSED_LOST.",
    parameters: Type.Object(
      {
        entity: entitySchema,
        id: nonEmptyString("Record id."),
        data: Type.Record(Type.String(), Type.Unknown(), {
          description: "Fields to update.",
        }),
      },
      { additionalProperties: false },
    ),
    resultContentSource: "network",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const args = asOptionalRecord(params) ?? {};
      const entity = readEntity(args);
      const id = readRequiredString(args, "id", "CRM record id");
      const data = readData(args, entity, "update");
      if (Object.keys(data).length === 0) {
        throw new Error("data must include at least one field to update.");
      }

      const config = createConfig(api);

      if (entity !== "deal") {
        return jsonResult(
          await crmRequest(config, {
            method: "PATCH",
            path: `/${ENTITY_PATH[entity]}/${encodeURIComponent(id)}`,
            body: { data },
            ...(signal ? { signal } : {}),
          }),
        );
      }

      const { stage, closedReason, ...dealData } = data;
      if (stage === undefined && closedReason !== undefined) {
        throw new Error("closedReason requires a stage update.");
      }
      if (stage === undefined) {
        return jsonResult(
          await crmRequest(config, {
            method: "PATCH",
            path: `/deals/${encodeURIComponent(id)}`,
            body: { data: dealData },
            ...(signal ? { signal } : {}),
          }),
        );
      }

      const stageBody: Record<string, unknown> = { stage: requireDealStage(stage) };
      if (typeof closedReason === "string" && closedReason.trim()) {
        stageBody.closedReason = closedReason.trim();
      }

      if (Object.keys(dealData).length === 0) {
        return jsonResult(
          await crmRequest(config, {
            method: "PATCH",
            path: `/deals/${encodeURIComponent(id)}/stage`,
            body: stageBody,
            ...(signal ? { signal } : {}),
          }),
        );
      }

      const record = await crmRequest(config, {
        method: "PATCH",
        path: `/deals/${encodeURIComponent(id)}`,
        body: { data: dealData },
        ...(signal ? { signal } : {}),
      });
      const stageResult = await crmRequest(config, {
        method: "PATCH",
        path: `/deals/${encodeURIComponent(id)}/stage`,
        body: stageBody,
        ...(signal ? { signal } : {}),
      });
      return jsonResult({ record, stage: stageResult });
    },
  };
}
