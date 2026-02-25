"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Navigation } from "@/components/navigation";
import { TEAM_DATA, type Team } from "@/lib/teams";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export default function TeamsPage() {
  const [teams, setTeams] = useState(TEAM_DATA.teams);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleSave = (team: Team) => {
    if (editingTeam) {
      setTeams(teams.map((t) => (t.subdomain === editingTeam.subdomain ? team : t)));
    } else {
      setTeams([...teams, team]);
    }
    setIsDialogOpen(false);
    setEditingTeam(null);
  };

  const handleDelete = (subdomain: string) => {
    if (confirm(`Team "${subdomain}" wirklich löschen?`)) {
      setTeams(teams.filter((t) => t.subdomain !== subdomain));
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <Navigation />
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">Team Konfiguration</h1>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => setEditingTeam(null)}>Team hinzufügen</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingTeam ? "Team bearbeiten" : "Neues Team"}
              </DialogTitle>
              <DialogDescription>
                {editingTeam
                  ? "Bearbeite die Team-Konfiguration"
                  : "Erstelle ein neues Team"}
              </DialogDescription>
            </DialogHeader>
            <TeamForm
              team={editingTeam}
              onSave={handleSave}
              onCancel={() => {
                setIsDialogOpen(false);
                setEditingTeam(null);
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {teams.map((team) => (
          <Card key={team.subdomain}>
            <CardHeader>
              <CardTitle>{team.owner}</CardTitle>
              <div className="text-sm text-gray-600">{team.subdomain}</div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="font-medium">Sprache:</span> {team.lang}
                </div>
                <div>
                  <span className="font-medium">Tags:</span> {team.tags.join(", ")}
                </div>
                <div className="flex gap-2 mt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingTeam(team);
                      setIsDialogOpen(true);
                    }}
                  >
                    Bearbeiten
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleDelete(team.subdomain)}
                  >
                    Löschen
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function TeamForm({
  team,
  onSave,
  onCancel,
}: {
  team: Team | null;
  onSave: (team: Team) => void;
  onCancel: () => void;
}) {
  const [formData, setFormData] = useState<Team>(
    team || {
      subdomain: "",
      owner: "",
      lang: "de",
      tags: [],
    }
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Subdomain</label>
        <input
          type="text"
          value={formData.subdomain}
          onChange={(e) =>
            setFormData({ ...formData, subdomain: e.target.value })
          }
          className="w-full rounded-md border px-3 py-2"
          required
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Owner</label>
        <input
          type="text"
          value={formData.owner}
          onChange={(e) => setFormData({ ...formData, owner: e.target.value })}
          className="w-full rounded-md border px-3 py-2"
          required
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Sprache</label>
        <select
          value={formData.lang}
          onChange={(e) => setFormData({ ...formData, lang: e.target.value })}
          className="w-full rounded-md border px-3 py-2"
        >
          <option value="de">Deutsch</option>
          <option value="bs">Bosanski</option>
          <option value="en">English</option>
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Tags (kommagetrennt)</label>
        <input
          type="text"
          value={formData.tags.join(", ")}
          onChange={(e) =>
            setFormData({
              ...formData,
              tags: e.target.value.split(",").map((t) => t.trim()),
            })
          }
          className="w-full rounded-md border px-3 py-2"
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Abbrechen
        </Button>
        <Button type="submit">Speichern</Button>
      </div>
    </form>
  );
}
