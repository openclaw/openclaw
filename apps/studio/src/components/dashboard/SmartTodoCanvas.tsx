"use client";

import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FileText, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

interface SmartTodoCanvasProps {
  agentId?: string; // Optional, defaults to monitored agent
}

export function SmartTodoCanvas({ agentId }: SmartTodoCanvasProps) {
  const [items, setItems] = useState<TodoItem[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [hasReceivedData, setHasReceivedData] = useState(false);

  useEffect(() => {
    // Establish WebSocket connection
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("SmartTodoCanvas: Connected to WS");
      setIsConnected(true);
      if (agentId) {
        ws.send(JSON.stringify({ type: "subscribe", agentId }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Check for 'render_todo_ui' tool usage
        // Structure: { agentId, event: "tool_execution" | "tool_use", payload: { tool: "render_todo_ui", args: { items: [...] } } }
        // Or sometimes simplified in development: { tool: "render_todo_ui", args: ... }
        
        // Handling both cases defensively
        const toolName = data.payload?.tool || data.tool;
        const toolArgs = data.payload?.args || data.args;

        if (toolName === "render_todo_ui" && toolArgs?.items) {
           setItems(toolArgs.items);
           setHasReceivedData(true);
        }
      } catch (err) {
        console.error("SmartTodoCanvas: WS Message Error", err);
      }
    };

    ws.onclose = () => setIsConnected(false);

    return () => {
      ws.close();
    };
  }, [agentId]);

  // Animation variants
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.3 } }
  };

  const itemVariants = {
    hidden: { opacity: 0, x: 20 },
    visible: { opacity: 1, x: 0 }
  };

  if (!hasReceivedData) {
     return (
        <div className="flex flex-col items-center justify-center h-64 text-zinc-500 text-sm italic space-y-2 border border-dashed border-zinc-800 rounded-xl bg-zinc-900/20">
           <span>Waiting for Smart To-Do events...</span>
           {agentId && <span className="text-xs text-zinc-600">Listening to {agentId}</span>}
        </div>
     );
  }

  return (
    <div className="w-full h-full flex items-center justify-center p-8 bg-zinc-950/50 rounded-xl border border-zinc-800/50 backdrop-blur-sm">
      <motion.div
        className="flex items-center space-x-4 md:space-x-12"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Source File Icon */}
        <motion.div
           initial={{ x: -50, opacity: 0 }}
           animate={{ x: 0, opacity: 1 }}
           transition={{ duration: 0.5, type: "spring" }}
           className="hidden md:flex flex-col items-center space-y-2"
        >
           <div className="p-4 bg-zinc-800 rounded-2xl border border-zinc-700 shadow-lg">
              <FileText className="w-12 h-12 text-blue-400" />
           </div>
           <span className="text-xs text-zinc-400 font-medium">Source Context</span>
        </motion.div>

        {/* Animated Arrow */}
        <div className="hidden md:flex relative w-32 h-12 items-center justify-center">
            <motion.svg
              viewBox="0 0 100 24"
              className="w-full h-full text-zinc-600"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
               <motion.path
                 d="M0,12 L95,12"
                 fill="none"
                 stroke="currentColor"
                 strokeWidth="2"
                 initial={{ pathLength: 0 }}
                 animate={{ pathLength: 1 }}
                 transition={{ duration: 0.8, delay: 0.5, ease: "easeInOut" }}
               />
               <motion.path
                 d="M90,7 L100,12 L90,17"
                 fill="none"
                 stroke="currentColor"
                 strokeWidth="2"
                 initial={{ opacity: 0, x: -10 }}
                 animate={{ opacity: 1, x: 0 }}
                 transition={{ delay: 1.2, duration: 0.3 }}
               />
            </motion.svg>
        </div>

        {/* To-Do List Card */}
        <motion.div
           initial={{ scale: 0.9, opacity: 0 }}
           animate={{ scale: 1, opacity: 1 }}
           transition={{ delay: 0.8, duration: 0.4 }}
        >
          <Card className="w-80 bg-zinc-900/80 border-zinc-700/50 shadow-2xl backdrop-blur-xl">
             <CardHeader className="pb-3 border-b border-zinc-800/50">
                <CardTitle className="text-lg font-medium text-zinc-100 flex items-center gap-2">
                   <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                   Generated Plan
                </CardTitle>
             </CardHeader>
             <CardContent className="p-0">
                <ScrollArea className="h-[300px] p-4">
                   <motion.ul className="space-y-3">
                      <AnimatePresence>
                         {items.map((item, index) => (
                            <motion.li
                               key={item.id || index}
                               variants={itemVariants}
                               initial="hidden"
                               animate="visible"
                               transition={{ delay: 1.0 + (index * 0.1) }}
                               className="flex items-start gap-3 group"
                            >
                               <div className={cn(
                                  "mt-1 w-5 h-5 rounded border flex items-center justify-center transition-colors",
                                  item.completed
                                    ? "bg-emerald-500 border-emerald-500"
                                    : "border-zinc-600 bg-zinc-800 group-hover:border-zinc-500"
                               )}>
                                  {item.completed && <Check className="w-3.5 h-3.5 text-white" />}
                               </div>
                               <span className={cn(
                                  "text-sm leading-snug transition-colors",
                                  item.completed ? "text-zinc-500 line-through" : "text-zinc-300"
                               )}>
                                  {item.text}
                               </span>
                            </motion.li>
                         ))}
                      </AnimatePresence>
                   </motion.ul>
                </ScrollArea>
             </CardContent>
          </Card>
        </motion.div>
      </motion.div>
    </div>
  );
}
