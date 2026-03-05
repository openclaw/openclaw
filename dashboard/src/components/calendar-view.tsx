"use client";

import { useMemo } from "react";
import { GlassCard } from "@/components/ui/glass-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Calendar } from "lucide-react";

interface CalendarEvent {
  _id: string;
  title: string;
  start: number;
  end: number;
  type?: string;
  color?: string;
  description?: string;
}

interface CalendarViewProps {
  events?: CalendarEvent[];
}

const hours = Array.from({ length: 14 }, (_, i) => i + 7); // 7AM - 8PM
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function CalendarView({ events = [] }: CalendarViewProps) {
  const weekDates = useMemo(() => {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(startOfWeek);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, []);

  const getEventsForDay = (date: Date) => {
    const dayStart = new Date(date).setHours(0, 0, 0, 0);
    const dayEnd = new Date(date).setHours(23, 59, 59, 999);
    return events.filter((e) => e.start >= dayStart && e.start <= dayEnd);
  };

  if (events.length === 0) {
    return (
      <GlassCard>
        <EmptyState
          icon={Calendar}
          title="No events this week"
          description="Calendar events from Convex will appear here. Connect Convex to get started."
        />
      </GlassCard>
    );
  }

  return (
    <GlassCard padding="none" className="overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-8 border-b border-white/[0.06]">
        <div className="p-2 text-[10px] text-muted-foreground" />
        {weekDates.map((date, i) => {
          const isToday = date.toDateString() === new Date().toDateString();
          return (
            <div
              key={i}
              className={`p-2 text-center border-l border-white/[0.04] ${isToday ? "bg-primary/[0.06]" : ""}`}
            >
              <p className="text-[10px] text-muted-foreground">{days[i]}</p>
              <p className={`text-sm font-medium ${isToday ? "text-primary" : ""}`}>
                {date.getDate()}
              </p>
            </div>
          );
        })}
      </div>

      {/* Time grid */}
      <div className="max-h-[500px] overflow-y-auto">
        {hours.map((hour) => (
          <div key={hour} className="grid grid-cols-8 border-b border-white/[0.03] min-h-[40px]">
            <div className="p-1 text-[9px] text-muted-foreground text-right pr-2 pt-1">
              {hour > 12 ? `${hour - 12}PM` : hour === 12 ? "12PM" : `${hour}AM`}
            </div>
            {weekDates.map((date, dayIdx) => {
              const dayEvents = getEventsForDay(date).filter((e) => {
                const eventHour = new Date(e.start).getHours();
                return eventHour === hour;
              });
              return (
                <div
                  key={dayIdx}
                  className="border-l border-white/[0.03] relative p-0.5"
                >
                  {dayEvents.map((evt) => (
                    <div
                      key={evt._id}
                      className="rounded px-1 py-0.5 text-[9px] font-medium truncate mb-0.5"
                      style={{
                        backgroundColor: `${evt.color || "#6366f1"}20`,
                        color: evt.color || "#6366f1",
                        borderLeft: `2px solid ${evt.color || "#6366f1"}`,
                      }}
                    >
                      {evt.title}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </GlassCard>
  );
}
