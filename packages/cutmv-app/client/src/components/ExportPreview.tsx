/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Export Preview Component
 * Shows a quick visual preview to help identify exports
 */

import { useState, useEffect } from 'react';
import { Loader, AlertCircle, Download, FileVideo, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ExportPreviewProps {
  exportId: string;
  filename: string;
  format: string;
  downloadUrl?: string;
  aspectRatio?: string;
  videoId?: number;
  isOpen: boolean;
  onClose: () => void;
}

export function ExportPreview({
  exportId,
  filename,
  format,
  downloadUrl,
  aspectRatio,
  videoId,
  isOpen,
  onClose,
}: ExportPreviewProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Fetch preview thumbnail when modal opens
  useEffect(() => {
    if (isOpen && exportId) {
      fetchPreview();
    }
  }, [isOpen, exportId]);

  const fetchPreview = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/user/exports/${exportId}/preview`, {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to load preview');
      }

      const data = await response.json();
      setPreviewUrl(data.previewUrl);
      setIsLoading(false);
    } catch (err) {
      console.error('Preview error:', err);
      setError('Preview not available');
      setIsLoading(false);
    }
  };

  const handleImageLoad = () => {
    setIsLoading(false);
  };

  const handleImageError = () => {
    setIsLoading(false);
    setError('Failed to load preview');
  };

  // Determine preview dimensions based on aspect ratio
  const getPreviewDimensions = () => {
    if (aspectRatio === '9:16') {
      return 'max-w-[360px] aspect-[9/16]';
    }
    return 'max-w-[640px] aspect-video';
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5" />
            <span className="truncate pr-4">{filename}</span>
          </DialogTitle>
          <DialogDescription>
            {format} • {aspectRatio || '16:9'} • Quick preview to help identify this export
          </DialogDescription>
        </DialogHeader>

        <div className="relative w-full flex items-center justify-center bg-gray-100 dark:bg-gray-900 rounded-lg p-8 min-h-[400px]">
          {/* Loading state */}
          {isLoading && (
            <div className="flex items-center justify-center">
              <div className="text-center">
                <Loader className="w-8 h-8 animate-spin text-brand-green mx-auto mb-2" />
                <p className="text-sm text-gray-600 dark:text-gray-400">Loading preview...</p>
              </div>
            </div>
          )}

          {/* Error state */}
          {error && !isLoading && (
            <div className="flex items-center justify-center">
              <div className="text-center">
                <FileVideo className="w-16 h-16 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600 dark:text-gray-400 mb-2">Preview not available</p>
                <p className="text-sm text-gray-500">
                  This export is ready to download
                </p>
              </div>
            </div>
          )}

          {/* Preview video (shows first frame as poster) */}
          {previewUrl && !error && (
            <video
              src={previewUrl}
              className={`w-full ${getPreviewDimensions()} rounded-lg shadow-lg object-contain ${isLoading ? 'opacity-0' : 'opacity-100'} transition-opacity`}
              onLoadedData={handleImageLoad}
              onError={handleImageError}
              preload="metadata"
            >
              Your browser does not support video preview
            </video>
          )}
        </div>

        {/* Export info */}
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600 dark:text-gray-400">Export Type:</span>
            <span className="font-medium">{format}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600 dark:text-gray-400">Aspect Ratio:</span>
            <span className="font-medium">{aspectRatio || '16:9'}</span>
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 pt-2 border-t border-gray-200 dark:border-gray-700">
            This preview shows a representative frame to help you identify this export
          </div>
        </div>

        {/* Download button */}
        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {downloadUrl && (
            <Button
              onClick={() => window.open(downloadUrl, '_blank')}
              className="bg-brand-green hover:bg-brand-green-light text-brand-black"
            >
              <Download className="w-4 h-4 mr-2" />
              Download Export
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
