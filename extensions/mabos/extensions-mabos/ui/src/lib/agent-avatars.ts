/**
 * Agent avatar image paths.
 * Images are stored in /public/avatars/<agentId>.(png|jpg)
 * Generated via nano-banana-pro with geometric low-poly style.
 */

const base = import.meta.env.BASE_URL ?? "/";

export const agentAvatars: Record<string, string> = {
  ceo: `${base}avatars/ceo.png`,
  cfo: `${base}avatars/cfo.jpg`,
  cmo: `${base}avatars/cmo.jpg`,
  coo: `${base}avatars/coo.jpg`,
  cto: `${base}avatars/cto.jpg`,
  hr: `${base}avatars/hr.jpg`,
  knowledge: `${base}avatars/knowledge.jpg`,
  legal: `${base}avatars/legal.jpg`,
  strategy: `${base}avatars/strategy.jpg`,
  "inventory-mgr": `${base}avatars/inventory-mgr.jpg`,
  "fulfillment-mgr": `${base}avatars/fulfillment-mgr.jpg`,
  "product-mgr": `${base}avatars/product-mgr.jpg`,
  "marketing-dir": `${base}avatars/marketing-dir.png`,
  "sales-dir": `${base}avatars/sales-dir.png`,
  "compliance-dir": `${base}avatars/compliance-dir.png`,
  "creative-dir": `${base}avatars/creative-dir.png`,
  "cs-dir": `${base}avatars/cs-dir.png`,
};

/**
 * Get the avatar URL for an agent. Returns undefined if no avatar exists.
 */
export function getAgentAvatar(agentId: string): string | undefined {
  return agentAvatars[agentId];
}
