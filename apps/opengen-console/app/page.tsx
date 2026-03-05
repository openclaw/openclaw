import { ConsoleShell } from "../components/console-shell";

export default function HomePage() {
  return (
    <ConsoleShell title="总览">
      <p>OpenGen 控制台已就绪。你可以通过左侧导航发起生成或查看任务历史。</p>
    </ConsoleShell>
  );
}
