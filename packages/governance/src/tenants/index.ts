/**
 * Tenant module — public API.
 */

export { TenantService } from "./service.js";
export type {
  CreateTenantInput,
  AddAgentInput,
  CreateProjectInput,
  AddHumanInput,
  TenantServiceConfig,
} from "./service.js";

export {
  getTemplate,
  getTemplateWithOverrides,
  listEntityTypes,
  ENTITY_TYPE_LABELS,
} from "./templates.js";
