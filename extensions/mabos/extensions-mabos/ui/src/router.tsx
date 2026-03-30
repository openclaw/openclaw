import { createRouter, createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { AccountingPage } from "@/pages/AccountingPage";
import { AgentDetailPage } from "@/pages/AgentDetailPage";
import { AgentsPage } from "@/pages/AgentsPage";
import { AnalyticsPage } from "@/pages/AnalyticsPage";
import { BusinessGoalsPage } from "@/pages/BusinessGoalsPage";
import { CompliancePage } from "@/pages/CompliancePage";
import { CustomersPage } from "@/pages/CustomersPage";
import { DecisionsPage } from "@/pages/DecisionsPage";
import { EcommercePage } from "@/pages/EcommercePage";
import { GovernancePage } from "@/pages/GovernancePage";
import { InventoryPage } from "@/pages/InventoryPage";
import { KnowledgeGraphPage } from "@/pages/KnowledgeGraphPage";
import { LegalPage } from "@/pages/LegalPage";
import { MarketingPage } from "@/pages/MarketingPage";
import { OnboardingPage } from "@/pages/OnboardingPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { PerformancePage } from "@/pages/PerformancePage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { SuppliersPage } from "@/pages/SuppliersPage";
import { SupplyChainPage } from "@/pages/SupplyChainPage";
import { TasksPage } from "@/pages/TasksPage";
import { TimelinePage } from "@/pages/TimelinePage";
import { WorkflowEditorPage } from "@/pages/WorkflowEditorPage";
import { WorkflowsPage } from "@/pages/WorkflowsPage";

// Root layout
const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

// Route tree
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
});

// Agents layout route: renders Outlet for child routes
const agentsLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: () => <Outlet />,
});

// Index route for /agents (the grid)
const agentsIndexRoute = createRoute({
  getParentRoute: () => agentsLayoutRoute,
  path: "/",
  component: AgentsPage,
});

// Detail route for /agents/$agentId
const agentDetailRoute = createRoute({
  getParentRoute: () => agentsLayoutRoute,
  path: "$agentId",
  component: AgentDetailPage,
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectsPage,
});
const performanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/performance",
  component: PerformancePage,
});
const timelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/timeline",
  component: TimelinePage,
});
const inventoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inventory",
  component: InventoryPage,
});
const accountingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/accounting",
  component: AccountingPage,
});
const customersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers",
  component: CustomersPage,
});
const ecommerceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ecommerce",
  component: EcommercePage,
});
const suppliersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/suppliers",
  component: SuppliersPage,
});
const supplyChainRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/supply-chain",
  component: SupplyChainPage,
});
const legalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/legal",
  component: LegalPage,
});
const complianceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/compliance",
  component: CompliancePage,
});
const marketingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/marketing",
  component: MarketingPage,
});
const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/analytics",
  component: AnalyticsPage,
});
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage,
});
const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  component: TasksPage,
});
const decisionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/decisions",
  component: DecisionsPage,
});
const goalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/goals",
  component: BusinessGoalsPage,
});
const knowledgeGraphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/knowledge-graph",
  component: KnowledgeGraphPage,
});
const governanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/governance",
  component: GovernancePage,
});
// Workflows layout route: renders Outlet for child routes
const workflowsLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
  component: () => <Outlet />,
});

const workflowsIndexRoute = createRoute({
  getParentRoute: () => workflowsLayoutRoute,
  path: "/",
  component: WorkflowsPage,
});

const workflowEditorRoute = createRoute({
  getParentRoute: () => workflowsLayoutRoute,
  path: "$workflowId/edit",
  component: WorkflowEditorPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  agentsLayoutRoute.addChildren([agentsIndexRoute, agentDetailRoute]),
  projectsRoute,
  performanceRoute,
  timelineRoute,
  inventoryRoute,
  accountingRoute,
  customersRoute,
  ecommerceRoute,
  suppliersRoute,
  supplyChainRoute,
  legalRoute,
  complianceRoute,
  marketingRoute,
  analyticsRoute,
  tasksRoute,
  onboardingRoute,
  decisionsRoute,
  goalsRoute,
  knowledgeGraphRoute,
  governanceRoute,
  workflowsLayoutRoute.addChildren([workflowsIndexRoute, workflowEditorRoute]),
]);

export const router = createRouter({
  routeTree,
  basepath: "/mabos/dashboard",
});

// Type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
