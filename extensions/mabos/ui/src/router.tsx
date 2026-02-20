import {
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { OverviewPage } from "@/pages/OverviewPage";
import { AgentsPage } from "@/pages/AgentsPage";
import { AgentDetailPage } from "@/pages/AgentDetailPage";
import { TasksPage } from "@/pages/TasksPage";

// Root layout
const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

// Page components (inline placeholders for now)

function PerformancePage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Performance</h1>
      <p className="text-[var(--text-secondary)]">Metrics and analytics</p>
    </div>
  );
}

function TimelinePage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Timeline</h1>
      <p className="text-[var(--text-secondary)]">
        Project roadmap and milestones
      </p>
    </div>
  );
}

function InventoryPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Inventory</h1>
      <p className="text-[var(--text-secondary)]">Stock management</p>
    </div>
  );
}

function AccountingPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Accounting</h1>
      <p className="text-[var(--text-secondary)]">Financial management</p>
    </div>
  );
}

function HRPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">HR</h1>
      <p className="text-[var(--text-secondary)]">Workforce management</p>
    </div>
  );
}

function OnboardingPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Onboarding</h1>
      <p className="text-[var(--text-secondary)]">Set up a new business</p>
    </div>
  );
}

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

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  component: TasksPage,
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
const hrRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/hr",
  component: HRPage,
});
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  agentsLayoutRoute.addChildren([agentsIndexRoute, agentDetailRoute]),
  tasksRoute,
  performanceRoute,
  timelineRoute,
  inventoryRoute,
  accountingRoute,
  hrRoute,
  onboardingRoute,
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
