import { Handle, useNodeConnections, Position } from "@xyflow/react";
import { clsx } from "clsx";

interface BpmnHandleProps {
  type: "source" | "target";
  position: Position;
  maxConnections?: number;
  style?: React.CSSProperties;
}

export function BpmnHandle({ type, position, maxConnections = Infinity, style }: BpmnHandleProps) {
  const connections = useNodeConnections({ handleType: type });
  const full = connections.length >= maxConnections;

  return (
    <Handle
      type={type}
      position={position}
      isConnectableStart={!full}
      isConnectableEnd={!full}
      style={style}
      className={clsx(
        "!w-3 !h-3 !border-2 !border-[var(--bg-card)]",
        full ? "!bg-[var(--text-muted)] !cursor-not-allowed" : "!bg-[var(--accent-blue)]",
      )}
    />
  );
}
