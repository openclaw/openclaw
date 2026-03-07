/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Credit Balance Component
 * Display user's credit balance and transaction history
 */

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Coins, History, Gift, Zap } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface CreditTransaction {
  id: number;
  amount: number;
  transactionType: string;
  note?: string;
  createdAt: string;
  expiresAt?: string;
}

export function CreditBalance() {
  const { user, isAuthenticated } = useAuth();
  const [credits, setCredits] = useState<number>(0);
  const [history, setHistory] = useState<CreditTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (isAuthenticated && user) {
      fetchCreditData();
    }
  }, [isAuthenticated, user]);

  const fetchCreditData = async () => {
    try {
      setIsLoading(true);
      
      // Fetch balance and history in parallel
      const [balanceRes, historyRes] = await Promise.all([
        fetch('/api/credits/balance', { credentials: 'include' }),
        fetch('/api/credits/history?limit=20', { credentials: 'include' })
      ]);

      if (balanceRes.ok) {
        const balanceData = await balanceRes.json();
        setCredits(balanceData.credits || 0);
      }

      if (historyRes.ok) {
        const historyData = await historyRes.json();
        setHistory(historyData.history || []);
      }
    } catch (error) {
      console.error('Error fetching credit data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const formatTransactionType = (type: string) => {
    switch (type) {
      case 'referral_signup':
        return 'Referral Bonus';
      case 'first_export_bonus':
        return 'First Export Bonus';
      case 'export_usage':
        return 'Export Payment';
      case 'system_grant':
        return 'System Grant';
      default:
        return type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
    }
  };

  const getTransactionIcon = (type: string) => {
    switch (type) {
      case 'referral_signup':
        return <Gift className="w-4 h-4" />;
      case 'first_export_bonus':
        return <Zap className="w-4 h-4" />;
      case 'export_usage':
        return <Coins className="w-4 h-4" />;
      default:
        return <Coins className="w-4 h-4" />;
    }
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Coins className="w-5 h-5 text-brand-green" />
          Credit Balance
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Current Balance */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Available Credits:</span>
            <Badge variant="outline" className="text-lg font-bold px-3 py-1">
              {isLoading ? '...' : credits}
            </Badge>
          </div>

          {/* Credits Info */}
          <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-3">
            <p>💡 <strong>How to earn credits:</strong></p>
            <ul className="list-disc list-inside mt-1 space-y-1">
              <li>Get +1 credit for each user that signs up with your referral code</li>
              <li>Get +1 bonus credit on your first export</li>
            </ul>
            <p className="mt-2">🎯 <strong>Use credits:</strong> Pay for exports without payment</p>
          </div>

          {/* Transaction History */}
          {history.length > 0 && (
            <Collapsible open={showHistory} onOpenChange={setShowHistory}>
              <CollapsibleTrigger asChild>
                <Button variant="outline" size="sm" className="w-full">
                  <History className="w-4 h-4 mr-2" />
                  {showHistory ? 'Hide' : 'Show'} Transaction History
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 mt-3">
                {history.map((transaction) => (
                  <div
                    key={transaction.id}
                    className="flex items-center justify-between p-2 bg-gray-50 rounded-md"
                  >
                    <div className="flex items-center gap-2">
                      {getTransactionIcon(transaction.transactionType)}
                      <div>
                        <p className="text-sm font-medium">
                          {formatTransactionType(transaction.transactionType)}
                        </p>
                        {transaction.note && (
                          <p className="text-xs text-gray-500">{transaction.note}</p>
                        )}
                        <p className="text-xs text-gray-400">
                          {new Date(transaction.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <Badge 
                      variant={transaction.amount > 0 ? "default" : "secondary"}
                      className={transaction.amount > 0 ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}
                    >
                      {transaction.amount > 0 ? '+' : ''}{transaction.amount}
                    </Badge>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Refresh Button */}
          <Button 
            onClick={fetchCreditData} 
            variant="outline" 
            size="sm" 
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? 'Loading...' : 'Refresh Balance'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}