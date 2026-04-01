import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useChatState } from "@/contexts/ChatContext";
import { usePanels } from "@/contexts/PanelContext";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";

export function CollapsedChatButton() {
  const { lastActiveAgent, maximizeChat } = useChatState();
  const { isPanelExpanded } = usePanels();
  const Icon = getAgentIcon(lastActiveAgent);
  const name = getAgentName(lastActiveAgent);

  return (
    <div
      className={`fixed bottom-[40px] left-1/2 -translate-x-1/2 ${isPanelExpanded ? "z-[60]" : "z-[30]"} max-[480px]:bottom-[20px]`}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={maximizeChat}
              className="flex items-center justify-center w-14 h-14 rounded-full bg-[var(--accent-purple)] text-white shadow-lg hover:opacity-90 transition-opacity"
              aria-label={`Open chat with ${name}`}
            >
              <Icon className="w-6 h-6" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{name}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
