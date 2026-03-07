import { useState, useEffect, useCallback } from "react";
import { Info, Shuffle, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Timestamp } from "@shared/schema";

interface TimestampInputProps {
  videoId?: number;
  timestampText: string;
  setTimestampText: (text: string) => void;
  onTimestampsParsed: (data: { timestamps: Timestamp[]; errors: string[]; warnings: string[] }) => void;
  onGenerateTimestamps?: () => void;
}

function TimestampInput({
  videoId,
  timestampText,
  setTimestampText,
  onTimestampsParsed,
  onGenerateTimestamps,
}: TimestampInputProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const { toast } = useToast();

  const handleAutoParseTimestamps = useCallback(async () => {
    if (!videoId || !timestampText.trim() || isOptimizing) {
      return;
    }

    setIsOptimizing(true);

    try {
      const response = await apiRequest('POST', '/api/parse-timestamps', {
        text: timestampText,
        videoId,
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      onTimestampsParsed(data);
      
      // Only show errors if there are no valid timestamps at all
      if (data.timestamps.length === 0 && data.errors.length > 0) {
        toast({
          title: "Timestamp format issue",
          description: "Please check your timestamp format and try again.",
          variant: "destructive",
        });
      }
    } catch (error: any) {
      console.error('Parse error:', error);
      // For 404 errors (video not found), show a helpful message
      if (error.message?.includes('404')) {
        toast({
          title: "Video not ready",
          description: "Please wait for video upload to complete before adding timestamps.",
          variant: "destructive",
        });
      }
      // Silently handle other parsing errors for auto-parsing
    } finally {
      setIsOptimizing(false);
    }
  }, [videoId, timestampText, isOptimizing, onTimestampsParsed, toast]);

  // Auto-parse timestamps when they change (with debounce)
  useEffect(() => {
    if (!videoId || !timestampText.trim()) {
      return;
    }

    const timeoutId = setTimeout(() => {
      handleAutoParseTimestamps();
    }, 1000); // 1 second debounce

    return () => clearTimeout(timeoutId);
  }, [timestampText, videoId, handleAutoParseTimestamps]);

  const handleGenerate5Cuts = () => {
    if (!videoId) {
      toast({
        title: "No video uploaded",
        description: "Please upload a video first.",
        variant: "destructive",
      });
      return;
    }

    // Use the callback from parent component (PricingCalculator)
    if (onGenerateTimestamps) {
      onGenerateTimestamps();
    } else {
      toast({
        title: "Generation not available",
        description: "Auto-generation is not configured for this component.",
        variant: "destructive",
      });
    }
  };

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Auto 5-Cut Generator */}
        <div className="bg-gradient-to-r from-purple-50 to-blue-50 border border-purple-200 rounded-lg p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-2">
              <Wand2 className="w-5 h-5 text-purple-600" />
              <div>
                <h3 className="font-medium text-gray-800">Quick Start</h3>
                <p className="text-sm text-gray-600">Auto-generate clips based on video length</p>
              </div>
            </div>
            <Button
              onClick={handleGenerate5Cuts}
              disabled={!videoId}
              variant="outline"
              className="border-purple-300 text-purple-700 hover:bg-purple-50 w-full sm:w-auto"
            >
              <Shuffle className="w-4 h-4 mr-2" />
              Auto Generate
            </Button>
          </div>
        </div>

        {/* Timestamp Input with Info Icon */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-700">
                Timestamp Format
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-4 h-4 text-gray-400 hover:text-gray-600 cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-sm">Supports various formats (: ; .) and separators (- – ,)</p>
                </TooltipContent>
              </Tooltip>
            </div>
            {isOptimizing && (
              <div className="text-xs text-gray-500 flex items-center gap-1">
                <div className="w-2 h-2 bg-brand-green rounded-full animate-pulse"></div>
                Optimizing clips...
              </div>
            )}
          </div>
          <Textarea
            value={timestampText}
            onChange={(e) => setTimestampText(e.target.value)}
            className="w-full h-32 resize-none focus:ring-2 focus:ring-brand-green focus:border-transparent"
            placeholder="Enter timestamps manually, one per line (e.g. 0:16-0:35) or use 'Auto Generate' above for quick start!"
          />
          {timestampText.trim() && !isOptimizing && (
            <div className="text-xs text-gray-500">
              ✨ Automatically optimizing timestamps for best results
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

export default TimestampInput;
