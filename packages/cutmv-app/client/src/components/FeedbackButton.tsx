/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { useState } from "react";
import { MessageCircle, X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { logUserEvent } from "@/lib/sentry";

export default function FeedbackButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [feedback, setFeedback] = useState({
    loved: "",
    improve: "",
    recommend: "",
    email: ""
  });
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      // Submit feedback to internal API
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(feedback)
      });

      const result = await response.json();

      if (result.success) {
        toast({
          title: "Thank you for your feedback!",
          description: "Your insights help us improve CUTMV for everyone.",
          variant: "default",
        });

        // Log successful submission to Sentry
        logUserEvent('feedback_submitted_success', {
          feedbackId: result.id,
          hasLoved: !!feedback.loved.trim(),
          hasImprove: !!feedback.improve.trim(),
          recommend: feedback.recommend,
          hasEmail: !!feedback.email.trim()
        });
      } else {
        throw new Error(result.message || 'Failed to submit feedback');
      }
    } catch (error) {
      console.error('Feedback submission error:', error);
      toast({
        title: "Submission failed",
        description: "Please try again or contact support.",
        variant: "destructive",
      });

      // Log error to Sentry
      logUserEvent('feedback_submission_error', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    // Reset form and close
    setFeedback({ loved: "", improve: "", recommend: "", email: "" });
    setIsOpen(false);
  };

  const openDirectForm = () => {
    // Log quick form preference
    logUserEvent('feedback_quick_form_used', { method: 'internal_modal' });
    
    // Show user they can use the quick form
    toast({
      title: "Quick feedback available!",
      description: "Use the form below for faster feedback submission.",
      variant: "default",
    });
  };

  return (
    <>
      {/* Floating Feedback Button */}
      <div className="fixed bottom-6 right-6 z-50">
        <Button
          data-feedback-button
          onClick={() => {
            setIsOpen(true);
            logUserEvent('feedback_button_clicked');
          }}
          className="bg-brand-green hover:bg-brand-green/90 text-brand-black font-medium shadow-lg hover:shadow-xl transition-all duration-300 rounded-full px-4 py-3"
          size="sm"
        >
          <MessageCircle className="w-4 h-4 mr-2" />
          Give Feedback
        </Button>
      </div>

      {/* Feedback Modal */}
      {isOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md bg-white">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-lg font-semibold text-gray-900">
                Help Us Improve CUTMV
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsOpen(false)}
                className="h-8 w-8 p-0"
              >
                <X className="w-4 h-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-gray-600">
                Your feedback helps us make CUTMV better for everyone. Share your thoughts below or use our detailed form.
              </p>
              
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-xs text-blue-800">
                  <strong>Need technical support?</strong> For bugs, processing issues, or urgent assistance, use our 
                  <a href="/support" className="text-blue-600 hover:underline ml-1">dedicated support form</a> instead.
                </p>
              </div>
              
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="loved" className="text-sm font-medium">
                    What did you love about using CUTMV?
                  </Label>
                  <Textarea
                    id="loved"
                    placeholder="Tell us what worked well..."
                    value={feedback.loved}
                    onChange={(e) => setFeedback({ ...feedback, loved: e.target.value })}
                    className="min-h-[60px] text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="improve" className="text-sm font-medium">
                    What would you improve or change?
                  </Label>
                  <Textarea
                    id="improve"
                    placeholder="Any pain points or suggestions..."
                    value={feedback.improve}
                    onChange={(e) => setFeedback({ ...feedback, improve: e.target.value })}
                    className="min-h-[60px] text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="recommend" className="text-sm font-medium">
                    Would you recommend this to others?
                  </Label>
                  <Select value={feedback.recommend} onValueChange={(value) => setFeedback({ ...feedback, recommend: value })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an option" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Yes, definitely!</SelectItem>
                      <SelectItem value="maybe">Maybe</SelectItem>
                      <SelectItem value="no">No, not yet</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email" className="text-sm font-medium">
                    Email (optional)
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="your@email.com"
                    value={feedback.email}
                    onChange={(e) => setFeedback({ ...feedback, email: e.target.value })}
                    className="text-sm"
                  />
                  <p className="text-xs text-gray-500">
                    Leave your email if you'd like us to follow up
                  </p>
                </div>

                <div className="flex gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsOpen(false)}
                    className="flex-1 text-sm"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1 bg-brand-green hover:bg-brand-green/90 text-brand-black text-sm"
                  >
                    Send Feedback
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}