import {
  LayoutDashboard,
  Users,
  FolderKanban,
  Calendar,
  BarChart3,
  Package,
  DollarSign,
  ShoppingCart,
  Building2,
  Truck,
  Scale,
  ShieldCheck,
  Megaphone,
  LineChart,
  Bell,
  Target,
  GitBranch,
  Network,
  ClipboardList,
} from "lucide-react";

export type NavItem = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  path: string;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

export const navSections: NavSection[] = [
  {
    title: "Strategy",
    items: [
      { icon: LayoutDashboard, label: "Overview", path: "/" },
      { icon: BarChart3, label: "Performance", path: "/performance" },
      { icon: Bell, label: "Decisions", path: "/decisions" },
      { icon: Target, label: "Goals", path: "/goals" },
      { icon: LineChart, label: "Analytics", path: "/analytics" },
    ],
  },
  {
    title: "Process",
    items: [
      { icon: FolderKanban, label: "Projects", path: "/projects" },
      { icon: ClipboardList, label: "Tasks", path: "/tasks" },
      { icon: Calendar, label: "Timeline", path: "/timeline" },
      { icon: GitBranch, label: "Workflows", path: "/workflows" },
    ],
  },
  {
    title: "Agents",
    items: [
      { icon: Users, label: "Agents", path: "/agents" },
      { icon: Network, label: "Knowledge Graph", path: "/knowledge-graph" },
    ],
  },
  {
    title: "Commerce",
    items: [
      { icon: ShoppingCart, label: "E-Commerce", path: "/ecommerce" },
      { icon: Users, label: "Customers", path: "/customers" },
      { icon: Megaphone, label: "Marketing", path: "/marketing" },
      { icon: DollarSign, label: "Accounting", path: "/accounting" },
    ],
  },
  {
    title: "Operations",
    items: [
      { icon: Package, label: "Inventory", path: "/inventory" },
      { icon: Building2, label: "Suppliers", path: "/suppliers" },
      { icon: Truck, label: "Supply Chain", path: "/supply-chain" },
    ],
  },
  {
    title: "Governance",
    items: [
      { icon: Scale, label: "Legal", path: "/legal" },
      { icon: ShieldCheck, label: "Compliance", path: "/compliance" },
    ],
  },
];
