import { useChatState } from "@/contexts/ChatContext";
import { usePanels } from "@/contexts/PanelContext";

export function ChatBlurOverlay() {
  const { isMinimized } = useChatState();
  const { sidebarMode } = usePanels();
  const sidebarWidth = sidebarMode === "collapsed" ? 64 : 280;

  if (isMinimized) return null;

  return (
    <div
      className="chat-blur-overlay fixed right-0 bottom-0 h-[120px] z-[20] pointer-events-none"
      style={{ left: sidebarWidth }}
      aria-hidden="true"
    >
      <div
        className="w-full h-full"
        style={{
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 70%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 70%)",
          willChange: "backdrop-filter",
        }}
      />
    </div>
  );
}
