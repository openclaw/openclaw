import { useState, useRef, useCallback } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  connected: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
};

export function ChatComposer({ connected, busy, onSend, onStop }: Props) {
  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const canSend = connected && draft.trim().length > 0 && !busy;

  const handleSend = useCallback(() => {
    if (!canSend) {
      return;
    }
    onSend(draft);
    setDraft("");
    if (taRef.current) {
      taRef.current.style.height = "auto";
    }
  }, [canSend, draft, onSend]);

  const handleKeydown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="mx-auto w-full max-w-2xl px-6 pb-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="flex items-end rounded-[28px] bg-card shadow-[var(--shadow-soft)] transition-shadow focus-within:shadow-[var(--shadow-soft-hover)] pr-2 pl-6"
      >
        <Textarea
          ref={taRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeydown}
          placeholder="Message your Companion..."
          rows={1}
          disabled={!connected}
          className="min-h-0 flex-1 border-0 bg-transparent px-0 py-4 shadow-none ring-0 focus-visible:ring-0 focus-visible:border-0 max-h-96 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden rounded-none"
        />
        {busy ? (
          <Button
            type="button"
            variant="brand"
            size="icon-sm"
            className="shrink-0 mb-2"
            onClick={onStop}
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            variant="brand"
            size="icon-sm"
            disabled={!canSend}
            className="shrink-0 mb-2"
          >
            <ArrowUp className="size-5" />
          </Button>
        )}
      </form>
    </div>
  );
}
