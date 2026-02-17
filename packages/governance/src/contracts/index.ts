/**
 * Permission Contracts — public API.
 *
 * @example
 * ```ts
 * import {
 *   PermissionContractService,
 *   type CreateContractInput,
 * } from "@six-fingered-man/governance/contracts";
 * import { generateDID } from "@six-fingered-man/governance/identity";
 *
 * const service = new PermissionContractService();
 *
 * const issuer = generateDID();
 * const agent = generateDID();
 * const target = generateDID();
 *
 * const contract = await service.create({
 *   issuerDid: issuer.did,
 *   issuerPrivateKey: issuer.privateKey,
 *   subjectDid: agent.did,
 *   actions: ["agent.message"],
 *   targetAgents: [target.did],
 *   durationMs: 3600_000, // 1 hour
 * });
 *
 * const result = service.check({
 *   actorDid: agent.did,
 *   action: "agent.message",
 *   targetDid: target.did,
 * });
 * // result.allowed === true
 * ```
 */

export { PermissionContractService, canonicalize } from "./service.js";
export type { CreateContractInput, CheckResult, ContractServiceConfig } from "./service.js";
