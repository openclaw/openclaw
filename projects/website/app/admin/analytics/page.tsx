'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { TrendingUp, Users, MousePointerClick, ShoppingCart, Activity } from 'lucide-react';

interface DailyStats {
  date: string;
  activeUsers: number;
  sessions: number;
  pageViews: number;
  conversions: number;
}

interface StatsData {
  success: boolean;
  period: number;
  totals: {
    totalUsers: number;
    totalSessions: number;
    totalPageViews: number;
    totalConversions: number;
  };
  dailyStats: DailyStats[];
}

interface FunnelData {
  success: boolean;
  period: number;
  funnel: {
    step1_explore: number;
    step2_view: number;
    step3_addToCart: number;
    step4_checkout: number;
    step5_purchase: number;
  };
  conversionRates: {
    exploreToView: string;
    viewToCart: string;
    cartToCheckout: string;
    checkoutToPurchase: string;
    overallConversion: string;
  };
}

export default function AnalyticsDashboard() {
  const [period, setPeriod] = useState<number>(7);
  const [statsData, setStatsData] = useState<StatsData | null>(null);
  const [funnelData, setFunnelData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAnalytics();
  }, [period]);

  const fetchAnalytics = async () => {
    setLoading(true);
    setError(null);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const [statsRes, funnelRes] = await Promise.all([
        fetch(`/api/analytics/stats?period=${period}`, { signal: controller.signal }),
        fetch(`/api/analytics/funnel?period=${period}`, { signal: controller.signal })
      ]);

      clearTimeout(timeoutId);

      if (!statsRes.ok || !funnelRes.ok) {
        const statsError = !statsRes.ok ? await statsRes.text() : '';
        const funnelError = !funnelRes.ok ? await funnelRes.text() : '';
        throw new Error(`API Error: ${statsError || funnelError}`);
      }

      const stats = await statsRes.json();
      const funnel = await funnelRes.json();

      if (!stats.success || !funnel.success) {
        throw new Error(stats.error || funnel.error || 'Unknown error');
      }

      setStatsData(stats);
      setFunnelData(funnel);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setError('請求超時，請重試');
      } else {
        setError(err.message || 'Failed to load analytics');
      }
      console.error('Analytics fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr: string) => {
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    return `${month}/${day}`;
  };

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat('zh-TW').format(num);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-primary/20 border-t-primary rounded-full animate-spin mx-auto"></div>
            <Activity className="w-8 h-8 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
          </div>
          <p className="mt-6 text-muted-foreground">載入數據中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <Activity className="w-8 h-8 text-destructive" />
          </div>
          <p className="text-destructive font-semibold text-lg">載入失敗</p>
          <p className="text-muted-foreground mt-2">{error}</p>
          <Button
            onClick={fetchAnalytics}
            className="mt-6 bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600"
          >
            重試
          </Button>
        </div>
      </div>
    );
  }

  const chartData = statsData?.dailyStats.map(day => ({
    date: formatDate(day.date),
    用戶數: day.activeUsers,
    工作階段: day.sessions,
    瀏覽量: day.pageViews,
    轉換數: day.conversions,
  })) || [];

  const funnelChartData = funnelData ? [
    { step: '探索課程', count: funnelData.funnel.step1_explore, rate: '100%' },
    { step: '查看課程', count: funnelData.funnel.step2_view, rate: `${funnelData.conversionRates.exploreToView}%` },
    { step: '加入購物車', count: funnelData.funnel.step3_addToCart, rate: `${funnelData.conversionRates.viewToCart}%` },
    { step: '開始結帳', count: funnelData.funnel.step4_checkout, rate: `${funnelData.conversionRates.cartToCheckout}%` },
    { step: '完成購買', count: funnelData.funnel.step5_purchase, rate: `${funnelData.conversionRates.checkoutToPurchase}%` },
  ] : [];

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Header Section */}
      <section className="relative overflow-hidden bg-gradient-to-br from-background via-primary/5 to-background pt-24 pb-12">
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-1/4 left-1/4 w-2 h-2 bg-primary/30 rounded-full animate-float-particles" style={{ animationDelay: "0s" }} />
          <div className="absolute top-1/3 right-1/3 w-1 h-1 bg-accent/40 rounded-full animate-float-particles" style={{ animationDelay: "2s" }} />
          <div className="absolute bottom-1/4 left-1/3 w-1.5 h-1.5 bg-primary/20 rounded-full animate-float-particles" style={{ animationDelay: "4s" }} />
          <div className="absolute top-1/2 right-1/4 w-1 h-1 bg-accent/30 rounded-full animate-float-particles" style={{ animationDelay: "1s" }} />
        </div>

        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto text-center">
            <h1 className="font-heading text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight animate-fade-in">
              GA4{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-orange-400 to-pink-600">
                分析儀表板
              </span>
            </h1>
            <p className="mt-4 text-lg text-muted-foreground animate-fade-in animate-delay-200">
              追蹤網站流量與轉換數據，洞察用戶行為
            </p>

            {/* Period Selector */}
            <div className="mt-8 flex gap-3 justify-center animate-fade-in animate-delay-300">
              {[7, 30, 90].map((days) => (
                <Button
                  key={days}
                  onClick={() => setPeriod(days)}
                  variant={period === days ? 'default' : 'outline'}
                  className={period === days
                    ? 'bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600 border-0'
                    : 'border-border/50 hover:bg-muted'
                  }
                >
                  最近 {days} 天
                </Button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="container mx-auto px-4 sm:px-6 lg:px-8 pb-16">
        {/* Key Metrics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8 -mt-8">
          <Card className="border-border/50 bg-card/80 backdrop-blur hover:border-primary/50 transition-all hover-lift">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardDescription className="text-xs uppercase tracking-wide">活躍用戶</CardDescription>
                <Users className="h-4 w-4 text-primary" />
              </div>
              <CardTitle className="text-3xl font-bold bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent">
                {formatNumber(statsData?.totals.totalUsers || 0)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">最近 {period} 天</p>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/80 backdrop-blur hover:border-primary/50 transition-all hover-lift">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardDescription className="text-xs uppercase tracking-wide">工作階段</CardDescription>
                <MousePointerClick className="h-4 w-4 text-primary" />
              </div>
              <CardTitle className="text-3xl font-bold bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent">
                {formatNumber(statsData?.totals.totalSessions || 0)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">最近 {period} 天</p>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/80 backdrop-blur hover:border-primary/50 transition-all hover-lift">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardDescription className="text-xs uppercase tracking-wide">頁面瀏覽量</CardDescription>
                <Activity className="h-4 w-4 text-primary" />
              </div>
              <CardTitle className="text-3xl font-bold bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent">
                {formatNumber(statsData?.totals.totalPageViews || 0)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">最近 {period} 天</p>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/80 backdrop-blur hover:border-primary/50 transition-all hover-lift">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardDescription className="text-xs uppercase tracking-wide">轉換次數</CardDescription>
                <ShoppingCart className="h-4 w-4 text-primary" />
              </div>
              <CardTitle className="text-3xl font-bold bg-gradient-to-br from-orange-500 to-pink-500 bg-clip-text text-transparent">
                {formatNumber(statsData?.totals.totalConversions || 0)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">最近 {period} 天</p>
            </CardContent>
          </Card>
        </div>

        {/* Daily Trends Chart */}
        <Card className="mb-8 border-border/50 bg-card/80 backdrop-blur">
          <CardHeader>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              <CardTitle className="text-2xl">每日趨勢</CardTitle>
            </div>
            <CardDescription>用戶活動與互動趨勢分析</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={350}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="colorUsers" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="rgb(249, 115, 22)" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="rgb(249, 115, 22)" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorSessions" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="rgb(236, 72, 153)" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="rgb(236, 72, 153)" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorPageViews" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="rgb(168, 85, 247)" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="rgb(168, 85, 247)" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                <XAxis
                  dataKey="date"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                    color: 'hsl(var(--foreground))'
                  }}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="用戶數"
                  stroke="rgb(249, 115, 22)"
                  fill="url(#colorUsers)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="工作階段"
                  stroke="rgb(236, 72, 153)"
                  fill="url(#colorSessions)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="瀏覽量"
                  stroke="rgb(168, 85, 247)"
                  fill="url(#colorPageViews)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Conversion Funnel */}
        <Card className="border-border/50 bg-card/80 backdrop-blur">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <ShoppingCart className="h-5 w-5 text-primary" />
                  <CardTitle className="text-2xl">轉換漏斗</CardTitle>
                </div>
                <CardDescription className="mt-2">
                  整體轉換率:{" "}
                  <span className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-orange-500 to-pink-500">
                    {funnelData?.conversionRates.overallConversion}%
                  </span>
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={funnelChartData} layout="vertical">
                <defs>
                  <linearGradient id="barGradient" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="rgb(249, 115, 22)" />
                    <stop offset="100%" stopColor="rgb(236, 72, 153)" />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <YAxis
                  dataKey="step"
                  type="category"
                  width={100}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="bg-card border border-border rounded-lg p-4 shadow-lg">
                          <p className="font-semibold text-foreground">{payload[0].payload.step}</p>
                          <p className="text-sm text-muted-foreground mt-1">
                            數量: <span className="font-medium text-foreground">{formatNumber(payload[0].value as number)}</span>
                          </p>
                          <p className="text-sm text-muted-foreground">
                            轉換率: <span className="font-medium text-primary">{payload[0].payload.rate}</span>
                          </p>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Bar
                  dataKey="count"
                  fill="url(#barGradient)"
                  radius={[0, 8, 8, 0]}
                />
              </BarChart>
            </ResponsiveContainer>

            {/* Funnel Conversion Rates */}
            <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center p-4 bg-gradient-to-br from-primary/10 to-primary/5 rounded-lg border border-primary/20">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">探索→查看</p>
                <p className="text-2xl font-bold text-primary mt-1">{funnelData?.conversionRates.exploreToView}%</p>
              </div>
              <div className="text-center p-4 bg-gradient-to-br from-primary/10 to-primary/5 rounded-lg border border-primary/20">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">查看→購物車</p>
                <p className="text-2xl font-bold text-primary mt-1">{funnelData?.conversionRates.viewToCart}%</p>
              </div>
              <div className="text-center p-4 bg-gradient-to-br from-primary/10 to-primary/5 rounded-lg border border-primary/20">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">購物車→結帳</p>
                <p className="text-2xl font-bold text-primary mt-1">{funnelData?.conversionRates.cartToCheckout}%</p>
              </div>
              <div className="text-center p-4 bg-gradient-to-br from-primary/10 to-primary/5 rounded-lg border border-primary/20">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">結帳→購買</p>
                <p className="text-2xl font-bold text-primary mt-1">{funnelData?.conversionRates.checkoutToPurchase}%</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
