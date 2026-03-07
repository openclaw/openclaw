import { Trash2, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Timestamp } from "@shared/schema";

interface TimestampPreviewProps {
  timestamps: Timestamp[];
  setTimestamps: (timestamps: Timestamp[]) => void;
}

export default function TimestampPreview({
  timestamps,
  setTimestamps,
}: TimestampPreviewProps) {
  const calculateDuration = (startTime: string, endTime: string): string => {
    const start = timeToSeconds(startTime);
    const end = timeToSeconds(endTime);
    const duration = end - start;
    
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const timeToSeconds = (timeStr: string): number => {
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return 0;
  };

  const handleRemoveTimestamp = (index: number) => {
    const newTimestamps = timestamps.filter((_, i) => i !== index);
    setTimestamps(newTimestamps);
  };

  return (
    <div className="space-y-4">
      {/* Clean Timestamp List */}
      {timestamps.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between mb-3 p-3 bg-green-50 border border-green-200 rounded-lg">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-600" />
              <span className="text-sm font-medium text-green-800">
                {timestamps.length} clips ready for processing
              </span>
            </div>
            <div className="text-xs text-green-600">
              ✨ Optimized for best quality
            </div>
          </div>
          
          {timestamps.map((timestamp, index) => (
            <div
              key={index}
              className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200"
            >
              <div className="flex-1">
                <div className="flex items-center space-x-3">
                  <span className="text-sm font-medium text-gray-900">Clip {index + 1}</span>
                  <span className="text-sm text-gray-600">
                    {timestamp.startTime} → {timestamp.endTime}
                  </span>
                  <span className="text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded">
                    {calculateDuration(timestamp.startTime, timestamp.endTime)}
                  </span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleRemoveTimestamp(index)}
                className="text-red-600 hover:text-red-700"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-6 text-gray-500 border-2 border-dashed border-gray-200 rounded-lg">
          <p className="text-sm">No clips detected yet</p>
          <p className="text-xs mt-1">Add timestamps above to see your clips here</p>
        </div>
      )}
    </div>
  );
}
