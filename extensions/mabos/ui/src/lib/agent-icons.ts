import {
  Star,
  DollarSign,
  Megaphone,
  Settings,
  Terminal,
  Heart,
  BookOpen,
  Scale,
  Compass,
  Package,
  Truck,
  Target,
  Briefcase,
  UserPlus,
  ShieldCheck,
  Pen,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";

export const agentIconMap: Record<string, LucideIcon> = {
  ceo: Star,
  cfo: DollarSign,
  cmo: Megaphone,
  coo: Settings,
  cto: Terminal,
  hr: Heart,
  knowledge: BookOpen,
  legal: Scale,
  strategy: Compass,
  inventory: Package,
  "inventory-mgr": Package,
  fulfillment: Truck,
  "fulfillment-mgr": Truck,
  product: Target,
  "product-mgr": Target,
  marketing: Briefcase,
  "marketing-dir": Briefcase,
  sales: UserPlus,
  "sales-dir": UserPlus,
  compliance: ShieldCheck,
  "compliance-dir": ShieldCheck,
  creative: Pen,
  "creative-dir": Pen,
  cs: MessageCircle,
  "cs-dir": MessageCircle,
};

export const agentNames: Record<string, string> = {
  ceo: "Atlas CEO",
  cfo: "Ledger CFO",
  cmo: "Spark CMO",
  coo: "Ops COO",
  cto: "Circuit CTO",
  hr: "Harbor HR",
  knowledge: "Oracle Knowledge",
  legal: "Shield Legal",
  strategy: "Compass Strategy",
  "inventory-mgr": "Inventory Manager",
  "fulfillment-mgr": "Fulfillment Manager",
  "product-mgr": "Product Manager",
  "marketing-dir": "Marketing Director",
  "sales-dir": "Sales Director",
  "compliance-dir": "Compliance Director",
  "creative-dir": "Creative Director",
  "cs-dir": "CS Director",
};

export function getAgentIcon(agentId: string): LucideIcon {
  return agentIconMap[agentId] || Star;
}

export function getAgentName(agentId: string): string {
  return agentNames[agentId] || agentId;
}
