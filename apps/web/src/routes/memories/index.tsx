"use client";

import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MemoryCard, MemoryDetailPanel, CreateMemoryModal } from "@/components/domain/memories";
import { CardSkeleton } from "@/components/composed/LoadingSkeleton";
import { ConfirmDialog } from "@/components/composed/ConfirmDialog";
import { useMemories, useMemorySearch } from "@/hooks/queries/useMemories";
import { useCreateMemory, useUpdateMemory, useDeleteMemory, useAddMemoryTags, useRemoveMemoryTags } from "@/hooks/mutations/useMemoryMutations";
import { useDebounce } from "@/hooks/useDebounce";
import {
  Brain,
  Plus,
  Search,
  SlidersHorizontal,
  Tag,
  ArrowUpDown,
  FileText,
  Link as LinkIcon,
  MessageSquare,
  Lightbulb,
  Image,
  X,
} from "lucide-react";
import type { Memory, MemoryType } from "@/hooks/queries/useMemories";

import { RouteErrorFallback } from "@/components/composed";
export const Route = createFileRoute("/memories/")({
  component: MemoriesPage,
  errorComponent: RouteErrorFallback,
});

type SortOption = "date-desc" | "date-asc" | "relevance";

const typeOptions: { value: MemoryType | "all"; label: string; icon: typeof Brain }[] = [
  { value: "all", label: "All Types", icon: Brain },
  { value: "note", label: "Note", icon: FileText },
  { value: "document", label: "Document", icon: FileText },
  { value: "link", label: "Link", icon: LinkIcon },
  { value: "image", label: "Image", icon: Image },
  { value: "conversation", label: "Conversation", icon: MessageSquare },
  { value: "insight", label: "Insight", icon: Lightbulb },
];

const sortOptions: { value: SortOption; label: string }[] = [
  { value: "date-desc", label: "Newest First" },
  { value: "date-asc", label: "Oldest First" },
  { value: "relevance", label: "Relevance" },
];

// Get all unique tags from memories
function getAllTags(memories: Memory[]): string[] {
  const tagSet = new Set<string>();
  memories.forEach((memory) => {
    memory.tags.forEach((tag) => tagSet.add(tag));
  });
  return Array.from(tagSet).toSorted();
}

// Animation variants for staggered grid
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
    },
  },
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      type: "spring" as const,
      stiffness: 300,
      damping: 24,
    },
  },
};

function MemoriesPage() {
  const [searchQuery, setSearchQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<MemoryType | "all">("all");
  const [selectedTags, setSelectedTags] = React.useState<string[]>([]);
  const [sortBy, setSortBy] = React.useState<SortOption>("date-desc");
  const [selectedMemory, setSelectedMemory] = React.useState<Memory | null>(null);
  const [isDetailOpen, setIsDetailOpen] = React.useState(false);
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = React.useState<string | null>(null);
  const [deleteConfirmTitle, setDeleteConfirmTitle] = React.useState("");

  const debouncedSearch = useDebounce(searchQuery, 300);

  // Use search query if provided, otherwise fetch all
  const { data: allMemories, isLoading: isLoadingAll } = useMemories();
  const { data: searchResults, isLoading: isSearching } = useMemorySearch(debouncedSearch);

  const createMemory = useCreateMemory();
  const updateMemory = useUpdateMemory();
  const deleteMemory = useDeleteMemory();
  const addTags = useAddMemoryTags();
  const removeTags = useRemoveMemoryTags();

  // Determine which data to use
  const memories = debouncedSearch ? searchResults : allMemories;
  const isLoading = debouncedSearch ? isSearching : isLoadingAll;

  // Get all available tags from memories
  const availableTags = React.useMemo(() => {
    return getAllTags(allMemories || []);
  }, [allMemories]);

  // Filter and sort memories
  const filteredMemories = React.useMemo(() => {
    if (!memories) {return [];}

    let result = [...memories];

    // Type filter
    if (typeFilter !== "all") {
      result = result.filter((memory) => memory.type === typeFilter);
    }

    // Tag filter
    if (selectedTags.length > 0) {
      result = result.filter((memory) =>
        selectedTags.every((tag) => memory.tags.includes(tag))
      );
    }

    // Sort
    switch (sortBy) {
      case "date-asc":
        result.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        break;
      case "date-desc":
        result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case "relevance":
        // For search results, keep the API order (relevance-based)
        // For all memories, sort by updated date
        if (!debouncedSearch) {
          result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        }
        break;
    }

    return result;
  }, [memories, typeFilter, selectedTags, sortBy, debouncedSearch]);

  const handleViewDetails = (memory: Memory) => {
    setSelectedMemory(memory);
    setIsDetailOpen(true);
  };

  const handleTagToggle = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const clearFilters = () => {
    setTypeFilter("all");
    setSelectedTags([]);
    setSortBy("date-desc");
  };

  const handleCreateMemory = (data: {
    title: string;
    content: string;
    type: MemoryType;
    tags: string[];
  }) => {
    createMemory.mutate(data, {
      onSuccess: () => {
        setIsCreateOpen(false);
      },
    });
  };

  const handleSaveMemory = (memory: Memory) => {
    updateMemory.mutate({
      id: memory.id,
      content: memory.content,
      tags: memory.tags,
    });
  };

  // Direct delete - called from detail panel after its own confirmation
  const executeDeleteMemory = (id: string) => {
    deleteMemory.mutate(id);
    setIsDetailOpen(false);
  };

  // Request delete with confirmation - called from card
  const handleDeleteMemory = (id: string, title?: string) => {
    setDeleteConfirmId(id);
    setDeleteConfirmTitle(title || "this memory");
  };

  const confirmDeleteMemory = () => {
    if (deleteConfirmId) {
      deleteMemory.mutate(deleteConfirmId);
      setDeleteConfirmId(null);
    }
  };

  const handleAddTags = (id: string, tags: string[]) => {
    addTags.mutate({ id, tags });
  };

  const handleRemoveTags = (id: string, tags: string[]) => {
    removeTags.mutate({ id, tags });
  };

  // Convert Memory from query to MemoryCard format
  const convertToCardMemory = (memory: Memory) => ({
    id: memory.id,
    content: memory.content,
    source: memory.type,
    timestamp: new Date(memory.createdAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    tags: memory.tags,
  });

  const hasActiveFilters = typeFilter !== "all" || selectedTags.length > 0;

  return (
    <>
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-8"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                <Brain className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold tracking-tight text-foreground">
                  Memories
                </h1>
                <p className="text-muted-foreground">
                  Your knowledge base and saved information
                </p>
              </div>
            </div>
            <Button
              onClick={() => setIsCreateOpen(true)}
              className="h-11 rounded-xl gap-2"
            >
              <Plus className="h-4 w-4" />
              New Memory
            </Button>
          </div>
        </motion.div>

        {/* Filters */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="flex flex-col gap-4 mb-8"
        >
          <div className="flex flex-col sm:flex-row gap-3">
            {/* Search */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search memories..."
                className="h-11 pl-10 rounded-xl"
              />
            </div>

            {/* Type Filter */}
            <Select
              value={typeFilter}
              onValueChange={(value) => setTypeFilter(value as MemoryType | "all")}
            >
              <SelectTrigger className="h-11 w-full sm:w-[160px] rounded-xl">
                <SlidersHorizontal className="h-4 w-4 mr-2 text-muted-foreground" />
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                {typeOptions.map((option) => {
                  const Icon = option.icon;
                  return (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="flex items-center gap-2">
                        <Icon className="h-4 w-4" />
                        {option.label}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>

            {/* Tags Filter */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "h-11 rounded-xl gap-2",
                    selectedTags.length > 0 && "border-primary/50 bg-primary/5"
                  )}
                >
                  <Tag className="h-4 w-4" />
                  <span className="hidden sm:inline">Tags</span>
                  {selectedTags.length > 0 && (
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                      {selectedTags.length}
                    </Badge>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 max-h-80 overflow-y-auto">
                <DropdownMenuLabel>Filter by tags</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {availableTags.length > 0 ? (
                  availableTags.map((tag) => (
                    <DropdownMenuCheckboxItem
                      key={tag}
                      checked={selectedTags.includes(tag)}
                      onCheckedChange={() => handleTagToggle(tag)}
                    >
                      {tag}
                    </DropdownMenuCheckboxItem>
                  ))
                ) : (
                  <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                    No tags available
                  </div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Sort */}
            <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortOption)}>
              <SelectTrigger className="h-11 w-full sm:w-[140px] rounded-xl">
                <ArrowUpDown className="h-4 w-4 mr-2 text-muted-foreground" />
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                {sortOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Clear Filters */}
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="icon"
                onClick={clearFilters}
                className="h-11 w-11 rounded-xl shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Active Tag Badges */}
          {selectedTags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {selectedTags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="gap-1 pr-1 cursor-pointer hover:bg-secondary/80"
                  onClick={() => handleTagToggle(tag)}
                >
                  <Tag className="h-3 w-3" />
                  {tag}
                  <button className="ml-1 p-0.5 rounded-full hover:bg-destructive/20">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </motion.div>

        {/* Content */}
        {isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : filteredMemories.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center py-16 text-center"
          >
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
              <Brain className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-2">
              {searchQuery || hasActiveFilters
                ? "No matching memories"
                : "No memories yet"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-4">
              {searchQuery || hasActiveFilters
                ? "Try adjusting your search or filters"
                : "Start capturing knowledge and insights"}
            </p>
            {!searchQuery && !hasActiveFilters && (
              <Button
                onClick={() => setIsCreateOpen(true)}
                className="rounded-xl gap-2"
              >
                <Plus className="h-4 w-4" />
                Create Memory
              </Button>
            )}
          </motion.div>
        ) : (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="grid gap-6 md:grid-cols-2 lg:grid-cols-3"
          >
            <AnimatePresence mode="popLayout">
              {filteredMemories.map((memory) => (
                <motion.div
                  key={memory.id}
                  variants={itemVariants}
                  layout
                  exit={{ opacity: 0, scale: 0.9 }}
                >
                  <MemoryCard
                    memory={convertToCardMemory(memory)}
                    onClick={() => handleViewDetails(memory)}
                    onEdit={() => handleViewDetails(memory)}
                    onDelete={() => handleDeleteMemory(memory.id, memory.title)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}

        {/* Memory Detail Panel */}
        <MemoryDetailPanel
          memory={selectedMemory}
          open={isDetailOpen}
          onClose={() => setIsDetailOpen(false)}
          onSave={handleSaveMemory}
          onDelete={executeDeleteMemory}
          onAddTags={handleAddTags}
          onRemoveTags={handleRemoveTags}
        />

      {/* Create Memory Modal */}
      <CreateMemoryModal
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSubmit={handleCreateMemory}
        isLoading={createMemory.isPending}
      />

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => !open && setDeleteConfirmId(null)}
        title="Delete Memory"
        resource={
          deleteConfirmTitle
            ? { title: deleteConfirmTitle, subtitle: "Memory" }
            : undefined
        }
        description={`Are you sure you want to delete "${deleteConfirmTitle}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDeleteMemory}
      />
    </>
  );
}
