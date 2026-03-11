import { useMemo } from "react";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type MetricsData = {
  revenue?: { date: string; value: number }[];
  taskCompletion?: { date: string; completed: number; total: number }[];
  agentEfficiency?: {
    agentId: string;
    tasksCompleted: number;
    avgDuration: number;
  }[];
  bdiCycles?: { date: string; cycles: number }[];
};

type MetricsChartsProps = {
  data: MetricsData | undefined;
  isLoading: boolean;
};

// --- Mock data generators ---

function generateMockRevenue() {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return months.map((m, i) => ({
    date: m,
    value: 12000 + Math.round(Math.sin(i * 0.5) * 4000 + i * 800),
  }));
}

function generateMockTaskCompletion() {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return months.map((m, i) => ({
    date: m,
    completed: 30 + Math.round(i * 5 + Math.random() * 10),
    total: 40 + Math.round(i * 5 + 15),
  }));
}

function generateMockBdiCycles() {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return months.map((m, i) => ({
    date: m,
    cycles: 120 + Math.round(i * 15 + Math.sin(i) * 30),
  }));
}

function generateMockAgentEfficiency() {
  return [
    { agentId: "ceo", tasksCompleted: 42, avgDuration: 3.2 },
    { agentId: "cfo", tasksCompleted: 38, avgDuration: 4.1 },
    { agentId: "cmo", tasksCompleted: 35, avgDuration: 2.8 },
    { agentId: "coo", tasksCompleted: 51, avgDuration: 2.1 },
    { agentId: "cto", tasksCompleted: 46, avgDuration: 3.5 },
    { agentId: "hr", tasksCompleted: 28, avgDuration: 4.5 },
  ];
}

// --- Shared tooltip style ---

const tooltipStyle = {
  backgroundColor: "var(--bg-secondary)",
  border: "1px solid var(--border-mabos)",
  borderRadius: "8px",
  color: "var(--text-primary)",
};

const axisProps = {
  stroke: "var(--text-muted)",
  tick: { fill: "var(--text-muted)", fontSize: 12 },
  tickLine: false,
  axisLine: false,
};

// --- Chart card wrapper ---

function ChartCard({
  title,
  isLoading,
  children,
}: {
  title: string;
  isLoading: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-[200px] w-full bg-[var(--bg-secondary)]" />
          </div>
        ) : (
          <div className="h-[220px]">{children}</div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Main component ---

export function MetricsCharts({ data, isLoading }: MetricsChartsProps) {
  const revenue = useMemo(() => data?.revenue ?? generateMockRevenue(), [data?.revenue]);

  const taskCompletion = useMemo(
    () => data?.taskCompletion ?? generateMockTaskCompletion(),
    [data?.taskCompletion],
  );

  const bdiCycles = useMemo(() => data?.bdiCycles ?? generateMockBdiCycles(), [data?.bdiCycles]);

  const agentEfficiency = useMemo(
    () => data?.agentEfficiency ?? generateMockAgentEfficiency(),
    [data?.agentEfficiency],
  );

  // Sort agent efficiency for horizontal bar chart (ascending for bottom-up display)
  const sortedEfficiency = useMemo(
    () => [...agentEfficiency].sort((a, b) => a.tasksCompleted - b.tasksCompleted),
    [agentEfficiency],
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Revenue Line Chart */}
      <ChartCard title="Revenue" isLoading={isLoading}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={revenue}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-mabos)" vertical={false} />
            <XAxis dataKey="date" {...axisProps} />
            <YAxis {...axisProps} tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value: number | undefined) => [
                `$${(value ?? 0).toLocaleString()}`,
                "Revenue",
              ]}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="var(--accent-green)"
              strokeWidth={2}
              dot={false}
              activeDot={{
                r: 4,
                fill: "var(--accent-green)",
                stroke: "var(--bg-card)",
                strokeWidth: 2,
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Task Completion Area Chart */}
      <ChartCard title="Task Completion" isLoading={isLoading}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={taskCompletion}>
            <defs>
              <linearGradient id="blueGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent-blue)" stopOpacity={0.3} />
                <stop offset="100%" stopColor="var(--accent-blue)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-mabos)" vertical={false} />
            <XAxis dataKey="date" {...axisProps} />
            <YAxis {...axisProps} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value: number | undefined, name: string | undefined) => [
                value ?? 0,
                name === "completed" ? "Completed" : "Total",
              ]}
            />
            <Area
              type="monotone"
              dataKey="total"
              stroke="var(--text-muted)"
              strokeWidth={1}
              strokeDasharray="4 4"
              fill="none"
            />
            <Area
              type="monotone"
              dataKey="completed"
              stroke="var(--accent-blue)"
              strokeWidth={2}
              fill="url(#blueGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* BDI Cycles Bar Chart */}
      <ChartCard title="BDI Cycle Frequency" isLoading={isLoading}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bdiCycles}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-mabos)" vertical={false} />
            <XAxis dataKey="date" {...axisProps} />
            <YAxis {...axisProps} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value: number | undefined) => [value ?? 0, "Cycles"]}
            />
            <Bar dataKey="cycles" radius={[4, 4, 0, 0]} maxBarSize={32}>
              {bdiCycles.map((_entry, index) => (
                <Cell
                  key={`bdi-cell-${index}`}
                  fill="var(--accent-purple)"
                  opacity={0.7 + (index / bdiCycles.length) * 0.3}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Agent Efficiency Horizontal Bar Chart */}
      <ChartCard title="Agent Efficiency" isLoading={isLoading}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={sortedEfficiency} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-mabos)" horizontal={false} />
            <XAxis type="number" {...axisProps} />
            <YAxis
              type="category"
              dataKey="agentId"
              {...axisProps}
              width={48}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value: number | undefined) => [value ?? 0, "Tasks Completed"]}
            />
            <Bar
              dataKey="tasksCompleted"
              radius={[0, 4, 4, 0]}
              maxBarSize={20}
              fill="var(--accent-orange)"
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
