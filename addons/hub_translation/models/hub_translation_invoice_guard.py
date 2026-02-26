# pyright: reportMissingImports=false

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError


class HubTranslationInvoiceGuard(models.Model):
    _inherit = "account.move"

    hub_job_id = fields.Many2one("hub.translation.job", string="Translation Job", index=True)
    hub_pm_approval = fields.Boolean(string="PM Approval", compute="_compute_hub_pm_approval")
    hub_change_order_approved = fields.Boolean(string="Change Order Approved", default=False)

    @api.depends("hub_job_id", "hub_job_id.pm_id")
    def _compute_hub_pm_approval(self):
        for move in self:
            move.hub_pm_approval = bool(
                move.hub_job_id
                and move.hub_job_id.pm_id
                and move.hub_job_id.pm_id.id == self.env.user.id
            )

    @api.constrains("state")
    def _constrain_hub_invoicing_state_flow(self):
        for move in self:
            job = move.hub_job_id
            if not job:
                continue

            # Only enforce on actual transitions to cancel/draft.
            # This avoids blocking initial invoice creation (default state=draft)
            # and no-op writes that keep state unchanged.
            prior_state = move._origin.state if move._origin and move._origin.id else None
            state_changed = bool(prior_state) and prior_state != move.state

            if (
                state_changed
                and move.state in {"cancel", "draft"}
                and job.stage == "invoicing"
                and not move.hub_pm_approval
            ):
                raise ValidationError(
                    "Cannot cancel/reset invoice while linked translation job is in invoicing stage without PM approval."
                )

    @api.constrains("state")
    def _constrain_quote_invoice_divergence(self):
        for move in self:
            if move.state != "posted" or move.hub_change_order_approved:
                continue

            job = move.hub_job_id
            if not job or not job.sale_order_line_id or not job.sale_order_line_id.order_id:
                continue

            sale_order = job.sale_order_line_id.order_id
            so_total = sale_order.amount_total or 0.0
            so_total_abs = abs(so_total)
            if so_total_abs == 0:
                continue

            delta = abs((move.amount_total or 0.0) - so_total)
            pct = delta / so_total_abs
            if pct > 0.01:
                raise UserError(
                    "Invoice total diverges from linked sale order by "
                    f"{delta:.2f} ({pct * 100:.1f}%). "
                    "Posting is blocked unless change order is approved."
                )

    def write(self, vals):
        approved_before = {
            move.id: move.hub_change_order_approved for move in self if move.id
        }

        target_state = vals.get("state")
        if target_state in {"cancel", "draft"}:
            for move in self:
                job = move.hub_job_id
                if not job or job.stage != "invoicing":
                    continue
                if move.state == target_state:
                    continue

                is_job_pm = bool(job.pm_id and job.pm_id.id == self.env.user.id)
                if not is_job_pm:
                    raise ValidationError(
                        "Cannot cancel/reset invoice while linked translation job is in "
                        "invoicing stage without PM approval."
                    )

        approving = vals.get("hub_change_order_approved") is True
        is_pm = self.env.user.has_group("hub_translation.group_pm")
        is_manager = self.env.user.has_group("hub_translation.group_manager")

        if approving:
            if not (is_pm or is_manager):
                raise ValidationError(
                    "Only PM or Manager can approve change orders on invoices."
                )

        approving_only = approving and set(vals.keys()) <= {"hub_change_order_approved"}
        if approving_only and (is_pm or is_manager):
            result = super(HubTranslationInvoiceGuard, self.sudo()).write(vals)
        else:
            result = super().write(vals)

        if approving:
            for move in self.sudo().filtered(
                lambda m: not approved_before.get(m.id, False) and m.hub_change_order_approved
            ):
                job = move.hub_job_id
                if not job or not job.sale_order_line_id or not job.sale_order_line_id.order_id:
                    continue

                so_total = job.sale_order_line_id.order_id.amount_total or 0.0
                delta = abs((move.amount_total or 0.0) - so_total)
                so_total_abs = abs(so_total)
                pct = (delta / so_total_abs) if so_total_abs else 0.0

                self.env["hub.workflow.stage.event"].sudo().create(
                    {
                        "job_id": job.id,
                        "from_stage": job.stage,
                        "to_stage": job.stage,
                        "actor_id": self.env.user.id,
                        "method": "system",
                        "reason": f"Change order approved: {delta:.2f} ({pct * 100:.1f}%)",
                        "success": True,
                    }
                )

        return result
