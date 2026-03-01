import { Spinner } from "@fluentui/react-components";

export default function HydrateFallback() {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        width: "100vw",
        height: "100vh",
      }}
    >
      <Spinner size="medium" />
    </div>
  );
}
