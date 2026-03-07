/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { useState } from "react";
import { MessageCircle, X, Send, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/components/AuthGuard";

export default function FloatingFeedback() {
  const [isOpen, setIsOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [category, setCategory] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();

  const handleSubmit = async () => {
    if (!feedback.trim() || !category) {
      toast({
        title: "Missing Information",
        description: "Please fill in all fields before submitting.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      // Submit feedback to backend
      await apiRequest("POST", "/api/feedback", {
        feedback: feedback.trim(),
        category,
        rating,
        userEmail: user?.email || 'anonymous',
        page: window.location.pathname,
        timestamp: new Date().toISOString()
      });

      setHasSubmitted(true);
      toast({
        title: "Feedback Sent! 🙌",
        description: "Thanks for helping us improve CUTMV!",
        duration: 5000,
      });

      // Reset form after short delay
      setTimeout(() => {
        setIsOpen(false);
        setFeedback('');
        setCategory('');
        setRating(null);
        setHasSubmitted(false);
      }, 2000);

    } catch (error) {
      console.error('Failed to submit feedback:', error);
      toast({
        title: "Submission Failed",
        description: "Please try again or contact support.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      {/* Floating Button */}
      <div className="fixed right-6 bottom-6 z-50">
        <Button
          onClick={() => setIsOpen(true)}
          className="bg-brand-green hover:bg-brand-green/90 text-black shadow-lg hover:shadow-xl transition-all duration-200 rounded-full p-3"
          size="lg"
        >
          <MessageCircle className="w-5 h-5 mr-2" />
          Feedback
        </Button>
      </div>

      {/* Feedback Form Modal */}
      {isOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <Card className="w-full max-w-md bg-white dark:bg-gray-900 shadow-2xl">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xl font-bold text-gray-900 dark:text-white">
                  Share Your Feedback
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsOpen(false)}
                  className="hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Help us improve CUTMV with your thoughts
              </p>
            </CardHeader>

            <CardContent className="space-y-4">
              {!hasSubmitted ? (
                <>
                  {/* Category Selection */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      Feedback Type
                    </label>
                    <Select value={category} onValueChange={setCategory}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="What's this about?" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="feature-request">Feature Request</SelectItem>
                        <SelectItem value="bug-report">Bug Report</SelectItem>
                        <SelectItem value="ui-ux">User Experience</SelectItem>
                        <SelectItem value="performance">Performance</SelectItem>
                        <SelectItem value="general">General Feedback</SelectItem>
                        <SelectItem value="compliment">Love It!</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Rating */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      How's your experience? (optional)
                    </label>
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          onClick={() => setRating(star)}
                          className={`p-1 rounded transition-colors ${
                            rating && star <= rating
                              ? 'text-yellow-500'
                              : 'text-gray-300 hover:text-yellow-400'
                          }`}
                        >
                          <Star className={`w-5 h-5 ${rating && star <= rating ? 'fill-current' : ''}`} />
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Feedback Text */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      Your Feedback
                    </label>
                    <Textarea
                      placeholder="Tell us what you think, what could be better, or what you love..."
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                      rows={4}
                      maxLength={500}
                      className="resize-none"
                    />
                    <p className="text-xs text-gray-500 text-right">
                      {feedback.length}/500 characters
                    </p>
                  </div>

                  {/* Submit Button */}
                  <Button
                    onClick={handleSubmit}
                    disabled={isSubmitting || !feedback.trim() || !category}
                    className="w-full bg-brand-green hover:bg-brand-green/90 text-black font-medium"
                  >
                    {isSubmitting ? (
                      "Sending..."
                    ) : (
                      <>
                        <Send className="w-4 h-4 mr-2" />
                        Send Feedback
                      </>
                    )}
                  </Button>

                  {user?.email && (
                    <p className="text-xs text-gray-500 text-center">
                      Submitted as {user.email}
                    </p>
                  )}
                </>
              ) : (
                <div className="text-center py-8 space-y-4">
                  <div className="w-16 h-16 bg-brand-green rounded-full flex items-center justify-center mx-auto">
                    <MessageCircle className="w-8 h-8 text-black" />
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    Thank You!
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Your feedback helps us make CUTMV better for everyone.
                  </p>
                  <Badge variant="secondary" className="bg-brand-green/20 text-brand-green border-brand-green/30">
                    Feedback Received
                  </Badge>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}