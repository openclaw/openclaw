import { ConsoleShell } from "../../components/console-shell";
import { GenerateWorkspace } from "../../components/generate-workspace";

export default function GeneratePage() {
  return (
    <ConsoleShell title="生成">
      <GenerateWorkspace />
    </ConsoleShell>
  );
}
