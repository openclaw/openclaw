import { Users } from "lucide-react";
import { useState, useDeferredValue } from "react";
import { ContactTable } from "@/components/customers/ContactTable";
import { CustomerStatsRow } from "@/components/customers/CustomerStatsRow";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useContacts, useContactSearch } from "@/hooks/useCustomers";

const segmentOptions = ["all", "enterprise", "smb", "startup", "individual"] as const;

export function CustomersPage() {
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState("all");
  const deferredSearch = useDeferredValue(search);

  const { data: contactsData, isLoading: contactsLoading } = useContacts(
    segment !== "all" ? { segment } : undefined,
  );
  const { data: searchData, isLoading: searchLoading } = useContactSearch(deferredSearch);

  const isSearching = deferredSearch.length >= 2;
  const contacts = isSearching ? (searchData?.contacts ?? []) : (contactsData?.contacts ?? []);
  const loading = isSearching ? searchLoading : contactsLoading;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent-purple) 15%, var(--bg-card))",
          }}
        >
          <Users className="w-5 h-5 text-[var(--accent-purple)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Customers</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Contact and relationship management
          </p>
        </div>
      </div>

      {/* Stats */}
      <CustomerStatsRow contacts={contactsData?.contacts} isLoading={contactsLoading} />

      {/* Search + Filter + Table */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
              Contacts
            </CardTitle>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Search contacts..."
                className="text-xs px-3 py-1.5 rounded border border-[var(--border-mabos)] bg-[var(--bg-secondary)] text-[var(--text-primary)] w-48 placeholder:text-[var(--text-muted)]"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                className="text-xs px-2 py-1.5 rounded border border-[var(--border-mabos)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                value={segment}
                onChange={(e) => setSegment(e.target.value)}
              >
                {segmentOptions.map((s) => (
                  <option key={s} value={s}>
                    {s === "all" ? "All Segments" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ContactTable contacts={contacts} isLoading={loading} />
        </CardContent>
      </Card>
    </div>
  );
}
