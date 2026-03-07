/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { logUserEvent } from "@/lib/sentry";
import { ArrowLeft, Send, Headphones } from "lucide-react";
import { Link } from "wouter";
import Header from '@/components/Header';

const supportFormSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  subject: z.string().min(1, "Subject is required"),
  message: z.string().min(10, "Message must be at least 10 characters"),
});

type SupportFormData = z.infer<typeof supportFormSchema>;

export default function SupportPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const form = useForm<SupportFormData>({
    resolver: zodResolver(supportFormSchema),
    defaultValues: {
      email: "",
      subject: "",
      message: "",
    },
  });

  const onSubmit = async (data: SupportFormData) => {
    setIsSubmitting(true);

    try {
      // Add session context
      const sessionContext = {
        currentPage: '/support',
        userAgent: navigator.userAgent,
      };

      const response = await fetch('/api/support', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...data,
          sessionContext
        })
      });

      const result = await response.json();

      if (result.success) {
        toast({
          title: "Support request submitted",
          description: "Our team will respond via email soon. Thank you for contacting us!",
          variant: "default",
        });

        // Log successful submission
        logUserEvent('support_request_success', {
          supportId: result.id,
          subject: data.subject
        });

        // Reset form
        form.reset();
      } else {
        throw new Error(result.message || 'Failed to submit support request');
      }
    } catch (error) {
      console.error('Support submission error:', error);
      toast({
        title: "Submission failed",
        description: "Please try again or email us directly at staff@fulldigitalll.com",
        variant: "destructive",
      });

      // Log error
      logUserEvent('support_submission_error', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <Header />

      {/* Main Content */}
      <div className="max-w-2xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-8">
          <Headphones className="w-12 h-12 text-brand-green mx-auto mb-4" />
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            How can we help you?
          </h1>
          <p className="text-lg text-gray-600">
            Our support team is here to assist with any questions about CUTMV
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <Send className="w-5 h-5 mr-2 text-brand-green" />
              Contact Support
            </CardTitle>
            <CardDescription>
              Tell us about your issue and we'll get back to you via email as soon as possible.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email Address</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="your.email@example.com"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="subject"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Subject</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Briefly describe your issue"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="message"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Message</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Please provide as much detail as possible about your issue..."
                          className="min-h-[120px]"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full bg-brand-green hover:bg-brand-green/90 text-brand-black font-semibold"
                >
                  {isSubmitting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-brand-black border-t-transparent mr-2"></div>
                      Submitting...
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4 mr-2" />
                      Send Support Request
                    </>
                  )}
                </Button>
              </form>
            </Form>



            <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <p className="text-xs text-gray-600 text-center">
                This form sends directly to our support team at staff@fulldigitalll.com.
                Your request will be tracked and you'll receive email updates on progress.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Footer */}
      <footer className="bg-brand-black border-t border-gray-800 mt-12">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-center">
            <div className="flex items-center text-gray-300">
              <span className="text-sm">Powered by</span>
              <a 
                href="https://www.fulldigitalll.com" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-brand-green hover:text-brand-green-light transition-colors text-sm font-medium mx-2"
              >
                Full Digital
              </a>
            </div>
          </div>
          <div className="text-center mt-2">
            <p className="text-xs text-gray-400">
              Multi-Platinum Design Agency - Artwork, Animation, AR Filters, Visualizers, Websites & More
            </p>
            <div className="text-xs text-gray-500 mt-1 border-t border-gray-800 pt-2 space-y-1">
              <p>
                <a href="/" className="text-brand-green hover:text-brand-green-light underline">
                  Home
                </a>{" "}
                •{" "}
                <a href="/terms" className="text-brand-green hover:text-brand-green-light underline">
                  Terms
                </a>{" "}
                •{" "}
                <a href="/privacy" className="text-brand-green hover:text-brand-green-light underline">
                  Privacy
                </a>
              </p>
              <p>© 2026 Full Digital LLC. All rights reserved.</p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}