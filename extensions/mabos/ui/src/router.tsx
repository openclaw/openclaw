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
import { PerformancePage } from "@/pages/PerformancePage";
import { TimelinePage } from "@/pages/TimelinePage";
import { InventoryPage } from "@/pages/InventoryPage";
import { AccountingPage } from "@/pages/AccountingPage";
import { HRPage } from "@/pages/HRPage";
import { OnboardingPage } from "@/pages/OnboardingPage";

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
