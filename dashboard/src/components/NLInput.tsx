import { useState, useRef, useEffect } from "react";
import { sendNL } from "../api";

type Toast = {
  id: number;
  message: string;
  type: "success" | "error";
};

type Props = {
  onCommandsExecuted?: () => void;
};

let toastSeq = 0;

export function NLInput({ onCommandsExecuted }: Props) {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const addToast = (message: string, type: "success" | "error") => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = value.trim();
    if (!msg || loading) return;

    setValue("");
    setLoading(true);

    try {
      const result = await sendNL(msg);
      addToast(result.reply || "Done.", "success");
      if (result.commandsExecuted.length > 0) {
        onCommandsExecuted?.();
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Something went wrong.", "error");
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  // Keyboard shortcut: "/" focuses the input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      {/* Toast notifications */}
      <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-4 py-3 rounded-lg shadow-xl text-sm border animate-fade-in ${
              t.type === "success"
                ? "bg-gray-800 border-green-700/50 text-gray-100"
                : "bg-gray-800 border-red-700/50 text-red-200"
            }`}
          >
            <p className="leading-snug">{t.message}</p>
          </div>
        ))}
      </div>

      {/* Fixed bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-gray-800 bg-gray-950/90 backdrop-blur-md">
        <form onSubmit={handleSubmit} className="max-w-5xl mx-auto flex items-center gap-3 px-4 py-3">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder='Control your home… (press "/" to focus)'
            disabled={loading}
            className="flex-1 bg-gray-800 text-white text-sm rounded-lg px-4 py-2.5 border border-gray-700 focus:outline-none focus:border-blue-500 placeholder-gray-500 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!value.trim() || loading}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-w-[70px] flex items-center justify-center"
          >
            {loading ? (
              <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              "Send"
            )}
          </button>
        </form>
      </div>
    </>
  );
}
