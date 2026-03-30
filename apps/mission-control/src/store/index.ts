import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Task, Agent, Project, Memory, Doc, Contact, CostRecord } from '../types'
import { SEED_TASKS, SEED_AGENTS, SEED_PROJECTS, SEED_MEMORIES, SEED_DOCS, SEED_CONTACTS } from './seeds'

interface AppStore {
  // Data
  tasks: Task[]
  agents: Agent[]
  projects: Project[]
  memories: Memory[]
  docs: Doc[]
  contacts: Contact[]
  costs: CostRecord[]
  // UI State
  searchOpen: boolean
  quickCaptureOpen: boolean
  // Actions
  setSearchOpen: (v: boolean) => void
  setQuickCaptureOpen: (v: boolean) => void
  addTask: (t: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => void
  updateTask: (id: string, changes: Partial<Task>) => void
  moveTask: (id: string, status: Task['status']) => void
  deleteTask: (id: string) => void
  addMemory: (m: Omit<Memory, 'id' | 'createdAt'>) => void
  addDoc: (d: Omit<Doc, 'id' | 'createdAt' | 'updatedAt'>) => void
  addContact: (c: Omit<Contact, 'id'>) => void
  updateAgent: (id: string, changes: Partial<Agent>) => void
}

function uid() {
  return Math.random().toString(36).slice(2, 11)
}

export const useStore = create<AppStore>()(
  persist(
    (set) => ({
      tasks: SEED_TASKS,
      agents: SEED_AGENTS,
      projects: SEED_PROJECTS,
      memories: SEED_MEMORIES,
      docs: SEED_DOCS,
      contacts: SEED_CONTACTS,
      costs: [],
      searchOpen: false,
      quickCaptureOpen: false,

      setSearchOpen: (v) => set({ searchOpen: v }),
      setQuickCaptureOpen: (v) => set({ quickCaptureOpen: v }),

      addTask: (t) => set((s) => ({
        tasks: [...s.tasks, { ...t, id: uid(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
      })),

      updateTask: (id, changes) => set((s) => ({
        tasks: s.tasks.map(t => t.id === id ? { ...t, ...changes, updatedAt: new Date().toISOString() } : t)
      })),

      moveTask: (id, status) => set((s) => ({
        tasks: s.tasks.map(t => t.id === id ? {
          ...t, status, updatedAt: new Date().toISOString(),
          completedAt: status === 'done' ? new Date().toISOString() : t.completedAt
        } : t)
      })),

      deleteTask: (id) => set((s) => ({ tasks: s.tasks.filter(t => t.id !== id) })),

      addMemory: (m) => set((s) => ({
        memories: [{ ...m, id: uid(), createdAt: new Date().toISOString() }, ...s.memories]
      })),

      addDoc: (d) => set((s) => ({
        docs: [{ ...d, id: uid(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, ...s.docs]
      })),

      addContact: (c) => set((s) => ({
        contacts: [...s.contacts, { ...c, id: uid() }]
      })),

      updateAgent: (id, changes) => set((s) => ({
        agents: s.agents.map(a => a.id === id ? { ...a, ...changes } : a)
      })),
    }),
    { name: 'mission-control-v1' }
  )
)
